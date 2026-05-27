import type { ImageProvider, ImageGenRequest, ImageGenResult } from '../image-provider.interface.js';

// ─── Available models (verified via ListModels API, May 2026) ─────────────────
//
//  Imagen 4 family  →  endpoint :predict
//    imagen-4.0-generate-001
//    imagen-4.0-ultra-generate-001
//    imagen-4.0-fast-generate-001
//
//  Gemini native image output  →  endpoint :generateContent
//    gemini-2.5-flash-image
//    gemini-3.1-flash-image-preview
//    gemini-3-pro-image-preview
//    nano-banana-pro-preview
//
//  ⚠️  ALL image-generation models require a paid Google AI account.
//      Free-tier quota is 0 for all of them.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_GEMINI_MODEL = 'imagen-4.0-generate-001';

function isGeminiNativeModel(model: string) {
  return model.startsWith('gemini-') || model === 'nano-banana-pro-preview';
}

export class GeminiImageProvider implements ImageProvider {
  readonly supportsReference = false;

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_GEMINI_MODEL,
  ) {
    if (!apiKey) {
      throw new Error(
        'Gemini Imagen requiere una API key. Consíguela en aistudio.google.com → "Get API key". ' +
        'Nota: la generación de imágenes requiere cuenta de pago en Google AI.',
      );
    }
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    return isGeminiNativeModel(this.model)
      ? this._generateContent(req)
      : this._predict(req);
  }

  // ── Imagen 4 — :predict endpoint ──────────────────────────────────────────
  private async _predict(req: ImageGenRequest): Promise<ImageGenResult> {
    const url = `${BASE}/${this.model}:predict?key=${this.apiKey}`;

    const body = {
      instances:  [{ prompt: req.prompt }],
      parameters: {
        sampleCount:      1,
        aspectRatio:      '1:1',
        personGeneration: 'allow_adult',
      },
    };

    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
      const msg = err.error?.message ?? res.statusText;
      if (res.status === 400 && msg.toLowerCase().includes('paid')) {
        throw new Error('Gemini Imagen requiere cuenta de pago en Google AI. Activa la facturación en ai.dev/projects.');
      }
      throw new Error(`Gemini Imagen error ${res.status}: ${msg}`);
    }

    const data = await res.json() as { predictions?: Array<{ bytesBase64Encoded?: string }> };
    const base64 = data.predictions?.[0]?.bytesBase64Encoded;
    if (!base64) throw new Error('Gemini Imagen: la respuesta no contiene imagen');

    return { buffer: Buffer.from(base64, 'base64'), filename: `gemini_${Date.now()}.png` };
  }

  // ── Gemini native image output — :generateContent endpoint ────────────────
  private async _generateContent(req: ImageGenRequest): Promise<ImageGenResult> {
    const url = `${BASE}/${this.model}:generateContent?key=${this.apiKey}`;

    const body = {
      contents:         [{ parts: [{ text: req.prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    };

    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
      const msg = err.error?.message ?? res.statusText;
      if (res.status === 429) {
        throw new Error('Gemini: cuota agotada. La generación de imágenes con Gemini requiere cuenta de pago en Google AI.');
      }
      throw new Error(`Gemini error ${res.status}: ${msg}`);
    }

    const data = await res.json() as {
      candidates?: Array<{
        content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
      }>;
    };

    const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) throw new Error('Gemini: la respuesta no contiene imagen. El modelo puede requerir cuenta de pago.');

    const mime = part.inlineData.mimeType ?? 'image/png';
    const ext  = mime.split('/')[1] ?? 'png';
    return {
      buffer:   Buffer.from(part.inlineData.data, 'base64'),
      filename: `gemini_${Date.now()}.${ext}`,
    };
  }
}
