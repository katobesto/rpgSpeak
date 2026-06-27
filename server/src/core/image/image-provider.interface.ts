export interface ImageGenRequest {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  /** ComfyUI-specific: workflow name without the _api.json suffix. Ignored by other providers. */
  workflowName?: string;
  /** bzComfy-specific: LoRA name to use (overrides the workflow default). */
  loraName?: string;
  /** bzComfy-specific: LoRA strength 0–2. Default 1.0. */
  loraStrength?: number;
  /** ComfyUI FluxResolutionNode: megapixel value e.g. "2.0". Overrides the workflow default. */
  megapixel?: string;
  /** ComfyUI FluxResolutionNode: aspect_ratio value e.g. "5:7 (Balanced Portrait)". Must match node enum exactly. */
  aspectRatio?: string;
  /** Base-model filename override for workflows with a modelControl (e.g. UNETLoader unet_name). */
  baseModel?: string;
  /** Per-LoRA on/off + strength overrides for "Power Lora Loader (rgthree)" nodes. */
  powerLoraUpdates?: Array<{ key: string; on: boolean; strength?: number }>;
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
