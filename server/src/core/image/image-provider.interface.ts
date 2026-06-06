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

export type ImageProgressEvent =
  | { type: 'progress'; value: number; max: number }
  | { type: 'node'; nodeId: string; nodeName: string }
  | { type: 'preview'; dataUrl: string };

export interface ImageProvider {
  /** Whether this provider supports FaceID / reference-image generation. */
  readonly supportsReference: boolean;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
  generateWithReference?(req: ImageGenRequest & { referenceImagePath: string }): Promise<ImageGenResult>;
  /** Optional: stream progress events during generation. */
  generateWithProgress?(req: ImageGenRequest, onProgress: (evt: ImageProgressEvent) => void): Promise<ImageGenResult>;
}
