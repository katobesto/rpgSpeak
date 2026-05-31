import { ComfyUiService } from '../../../modules/characters/comfyui.service.js';
import type { ImageProvider, ImageGenRequest, ImageGenResult } from '../image-provider.interface.js';

export class ComfyUiImageProvider implements ImageProvider {
  readonly supportsReference = true;

  private readonly service: ComfyUiService;

  constructor(
    baseUrl: string,
    cfClientId?: string,
    cfClientSecret?: string,
  ) {
    this.service = new ComfyUiService(baseUrl, cfClientId, cfClientSecret);
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const workflow = req.workflowName ?? 'image_z_image_turbo';
    return this.service.generateImage(workflow, req.prompt);
  }

  async generateWithReference(
    req: ImageGenRequest & { referenceImagePath: string },
  ): Promise<ImageGenResult> {
    const workflow = req.workflowName ?? 'faceid_sdxl';
    return this.service.generateImageWithReference(workflow, req.prompt, req.referenceImagePath);
  }
}
