import type { ImageProvider, ImageGenRequest, ImageGenResult } from '../image-provider.interface.js';

const DEFAULT_MODEL = 'flux';
const BASE_URL = 'https://image.pollinations.ai/prompt';

export class PollinationsImageProvider implements ImageProvider {
  readonly supportsReference = false;

  constructor(private readonly model: string = DEFAULT_MODEL) {}

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const width  = req.width  ?? 512;
    const height = req.height ?? 512;
    const model  = this.model || DEFAULT_MODEL;

    // Use a random seed so each generation is unique (Pollinations caches by prompt+seed)
    const seed = Math.floor(Math.random() * 2_147_483_647);

    const url = `${BASE_URL}/${encodeURIComponent(req.prompt)}`
      + `?width=${width}&height=${height}`
      + `&model=${encodeURIComponent(model)}`
      + `&seed=${seed}`
      + `&nologo=true&nofeed=true`;

    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      throw new Error(`Pollinations.ai error ${res.status}: ${res.statusText}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, filename: `pollinations_${Date.now()}.jpg` };
  }
}
