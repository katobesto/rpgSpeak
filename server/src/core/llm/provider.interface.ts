import type { GenerateRequest, GenerateResponse, ProviderModel } from '@rpgspeak/shared';

export interface LLMProvider {
  readonly type: string;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  stream(request: GenerateRequest): AsyncGenerator<string, GenerateResponse, unknown>;
  listModels(): Promise<ProviderModel[]>;
  validate(): Promise<{ valid: boolean; error?: string }>;
}

export interface ProviderOptions {
  baseUrl: string;
  apiKey?: string | null;
  timeout?: number;
  headers?: Record<string, string>;
}
