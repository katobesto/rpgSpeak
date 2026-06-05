import fs from 'fs';
import path from 'path';
import type { ImageProvider, ImageGenRequest, ImageGenResult } from '../image-provider.interface.js';

interface BzImageInfo {
  filename: string;
  subfolder: string;
  type: string;
}

export class BzComfyImageProvider implements ImageProvider {
  readonly supportsReference = true;

  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    private readonly defaultWorkflow: string,
  ) {}

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const workflow = req.workflowName ?? this.defaultWorkflow;
    if (!workflow) {
      throw new Error(
        'bzComfy: no hay workflow configurado. Configura bzComfyWorkflow en Ajustes → Integraciones.',
      );
    }
    const promptId = await this.startGeneration(workflow, req.prompt, req.negativePrompt);
    const info = await this.waitForImage(promptId);
    const buffer = await this.downloadImage(info);
    return { buffer, filename: info.filename };
  }

  async generateWithReference(
    req: ImageGenRequest & { referenceImagePath: string },
  ): Promise<ImageGenResult> {
    const workflow = req.workflowName ?? this.defaultWorkflow;
    if (!workflow) {
      throw new Error('bzComfy: no hay workflow configurado.');
    }
    const referenceImageName = await this.uploadReference(req.referenceImagePath);
    const promptId = await this.startGeneration(
      workflow,
      req.prompt,
      req.negativePrompt,
      referenceImageName,
    );
    const info = await this.waitForImage(promptId);
    const buffer = await this.downloadImage(info);
    return { buffer, filename: info.filename };
  }

  private async startGeneration(
    workflow: string,
    prompt: string,
    negativePrompt?: string,
    referenceImageName?: string,
  ): Promise<string> {
    const body: Record<string, unknown> = { workflow, prompt };
    if (negativePrompt) body.negativePrompt = negativePrompt;
    if (referenceImageName) body.referenceImageName = referenceImageName;

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(
        `bzComfy: error iniciando generación (${res.status}): ${data?.error ?? res.statusText}`,
      );
    }

    const data = (await res.json()) as { promptId?: string };
    if (!data.promptId) throw new Error('bzComfy: respuesta sin promptId');
    return data.promptId;
  }

  // Consumes bzComfy's SSE progress stream using Node.js native fetch.
  // Events of interest: images (has the file info), done (generation complete), error.
  private async waitForImage(promptId: string): Promise<BzImageInfo> {
    const url =
      `${this.baseUrl}/api/progress/${encodeURIComponent(promptId)}` +
      `?token=${encodeURIComponent(this.apiToken)}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
    if (!res.ok || !res.body) {
      throw new Error(`bzComfy: SSE de progreso falló (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let imageInfo: BzImageInfo | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let evt: { type: string; data: unknown };
          try { evt = JSON.parse(line.slice(6)); } catch { continue; }

          if (evt.type === 'images') {
            const d = evt.data as { images?: BzImageInfo[] };
            if (d.images && d.images.length > 0) imageInfo = d.images[0];
          } else if (evt.type === 'done') {
            if (!imageInfo) throw new Error('bzComfy: generación completa pero sin imagen');
            return imageInfo;
          } else if (evt.type === 'error') {
            const d = evt.data as { message?: string };
            throw new Error(`bzComfy: ${d.message ?? 'error de generación'}`);
          }
        }
      }
    } finally {
      try { reader.cancel(); } catch { /* ignore */ }
    }

    if (imageInfo) return imageInfo;
    throw new Error('bzComfy: el stream SSE terminó inesperadamente sin imagen');
  }

  private async downloadImage(info: BzImageInfo): Promise<Buffer> {
    const qs = new URLSearchParams({
      filename: info.filename,
      subfolder: info.subfolder || '',
      type: info.type || 'output',
    });
    const res = await fetch(`${this.baseUrl}/api/image?${qs}`, {
      headers: { Authorization: `Bearer ${this.apiToken}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`bzComfy: error descargando imagen (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async uploadReference(localPath: string): Promise<string> {
    const buffer = fs.readFileSync(localPath);
    const ext = path.extname(localPath) || '.png';
    const filename = `ref_${Date.now()}${ext}`;

    const formData = new FormData();
    const blob = new Blob([buffer], { type: 'image/png' });
    formData.append('image', blob, filename);

    const res = await fetch(`${this.baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiToken}` },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(
        `bzComfy: error subiendo imagen de referencia (${res.status}): ${data?.error ?? res.statusText}`,
      );
    }

    const data = (await res.json()) as { name?: string };
    if (!data.name) throw new Error('bzComfy: la respuesta de upload no incluye el nombre del archivo');
    return data.name;
  }
}
