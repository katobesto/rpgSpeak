import { ComfyUiService, type ComfyProgressEvent } from '../../../modules/characters/comfyui.service.js';
import type { ImageProvider, ImageGenRequest, ImageGenResult, ImageProgressEvent } from '../image-provider.interface.js';

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
    return this.service.generateImage(workflow, req.prompt, {
      width: req.width,
      height: req.height,
      megapixel: req.megapixel,
      aspectRatio: req.aspectRatio,
    });
  }

  async generateWithReference(
    req: ImageGenRequest & { referenceImagePath: string },
    onProgress?: (evt: ImageProgressEvent) => void,
  ): Promise<ImageGenResult> {
    const workflow = req.workflowName ?? 'faceid_sdxl';
    // ComfyProgressEvent (progress|node, flat optional fields) → ImageProgressEvent
    // (discriminated union, also covers 'preview' which ComfyUI's WS doesn't emit here).
    const adapted = onProgress
      ? (evt: ComfyProgressEvent) => {
          if (evt.type === 'progress') onProgress({ type: 'progress', value: evt.value ?? 0, max: evt.max ?? 0 });
          else if (evt.type === 'node') onProgress({ type: 'node', nodeId: evt.nodeId ?? '', nodeName: evt.nodeName ?? '' });
        }
      : undefined;
    return this.service.generateImageWithReference(workflow, req.prompt, req.referenceImagePath, adapted);
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
    overrides?: { megapixel?: string; aspectRatio?: string },
  ) {
    return this.service.startProgressiveGeneration(workflowName, prompt, previewNodeId, finalNodeId, overrides);
  }

  startProgressiveWithProgress(
    workflowName: string,
    prompt: string,
    previewNodeId: string,
    finalNodeId: string,
    onProgress: (event: ComfyProgressEvent) => void,
    overrides?: { megapixel?: string; aspectRatio?: string },
  ) {
    return this.service.startProgressiveWithProgress(workflowName, prompt, previewNodeId, finalNodeId, onProgress, overrides);
  }

  /** Returns progressive meta if the workflow supports it, null otherwise. */
  getProgressiveMeta(workflowName: string): { previewNodeId: string; finalNodeId: string } | null {
    return this.service.loadWorkflowMeta(workflowName);
  }
}
