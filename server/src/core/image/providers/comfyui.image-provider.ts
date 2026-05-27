import { ComfyUiService } from '../../../modules/characters/comfyui.service.js';
import type { ImageProvider, ImageGenRequest, ImageGenResult } from '../image-provider.interface.js';

export class ComfyUiImageProvider implements ImageProvider {
  readonly supportsReference = true;

  private readonly service: ComfyUiService;

  constructor(baseUrl: string) {
    this.service = new ComfyUiService(baseUrl);
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    return this.service.generateImage('sdxl', req.prompt);
  }

  async generateWithReference(
    req: ImageGenRequest & { referenceImagePath: string },
  ): Promise<ImageGenResult> {
    return this.service.generateImageWithReference('faceid_sdxl', req.prompt, req.referenceImagePath);
  }
}
