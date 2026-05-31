export interface ImageGenRequest {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  /** ComfyUI-specific: workflow name without the _api.json suffix. Ignored by other providers. */
  workflowName?: string;
}

export interface ImageGenResult {
  buffer: Buffer;
  filename: string;
}

export interface ImageProvider {
  /** Whether this provider supports FaceID / reference-image generation. */
  readonly supportsReference: boolean;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
  generateWithReference?(req: ImageGenRequest & { referenceImagePath: string }): Promise<ImageGenResult>;
}
