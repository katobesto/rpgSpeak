import { ComfyUiService, type ComfyProgressEvent } from '../../../modules/characters/comfyui.service.js';
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

  /**
   * Start a progressive (two-phase) generation.
   * Returns two independent promises that resolve when each phase finishes.
   * Only available when the workflow has a _meta.json sidecar defining
   * previewNodeId and finalNodeId.
   */
  startProgressiveGeneration(
    workflowName: string,
    prompt: string,
    previewNodeId: string,
    finalNodeId: string,
  ) {
    return this.service.startProgressiveGeneration(workflowName, prompt, previewNodeId, finalNodeId);
  }

  startProgressiveWithProgress(
    workflowName: string,
    prompt: string,
    previewNodeId: string,
    finalNodeId: string,
    onProgress: (event: ComfyProgressEvent) => void,
  ) {
    return this.service.startProgressiveWithProgress(workflowName, prompt, previewNodeId, finalNodeId, onProgress);
  }

  /** Returns progressive meta if the workflow supports it, null otherwise. */
  getProgressiveMeta(workflowName: string): { previewNodeId: string; finalNodeId: string } | null {
    return this.service.loadWorkflowMeta(workflowName);
  }
}
