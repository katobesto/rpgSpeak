import type { ImageProvider, ImageGenRequest, ImageGenResult } from '../image-provider.interface.js';

const DEFAULT_MODEL = 'fal-ai/flux/schnell';

export class FalImageProvider implements ImageProvider {
  readonly supportsReference = false;

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL,
  ) {
    if (!apiKey) throw new Error('Fal.ai requiere una API key. Regístrate en fal.ai para obtenerla.');
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const endpoint = `https://fal.run/${this.model || DEFAULT_MODEL}`;

    const body: Record<string, unknown> = {
      prompt:          req.prompt,
      image_size:      'square_hd',
      num_images:      1,
      sync_mode:       true,
    };
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;

    const res = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${this.apiKey}`,
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { detail?: string; message?: string };
      throw new Error(
        `Fal.ai error ${res.status}: ${err.detail ?? err.message ?? res.statusText}`,
      );
    }

    const data = await res.json() as { images?: Array<{ url: string }> };
    const imageUrl = data.images?.[0]?.url;
    if (!imageUrl) throw new Error('Fal.ai: la respuesta no contiene URL de imagen');

    // Download the actual image bytes
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
    if (!imgRes.ok) throw new Error(`Fal.ai: error al descargar imagen (${imgRes.status})`);

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    return { buffer, filename: `fal_${Date.now()}.png` };
  }
}
