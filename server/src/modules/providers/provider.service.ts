import { ProviderRepository } from './provider.repository.js';
import { createProvider, invalidateProviderCache } from '../../core/llm/provider.factory.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import type { Provider, ProviderModel } from '@rpgspeak/shared';
import { z } from 'zod';

const repo = new ProviderRepository();

const createProviderSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['ollama', 'openai', 'lmstudio', 'mlx', 'kobold', 'oobabooga', 'openrouter', 'custom']),
  baseUrl: z.string().url(),
  apiKey: z.string().nullable().default(null),
  defaultModel: z.string().nullable().default(null),
  isEnabled: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
});

export class ProviderService {
  list(): Provider[] {
    return repo.findAll();
  }

  get(id: string): Provider {
    const p = repo.findById(id);
    if (!p) throw new NotFoundError('Provider', id);
    return p;
  }

  create(input: unknown): Provider {
    const result = createProviderSchema.safeParse(input);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    return repo.create(result.data);
  }

  update(id: string, input: unknown): Provider {
    this.get(id);
    const result = createProviderSchema.partial().safeParse(input);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    invalidateProviderCache(id);
    return repo.update(id, result.data)!;
  }

  delete(id: string): void {
    this.get(id);
    invalidateProviderCache(id);
    repo.delete(id);
  }

  async listModels(id: string): Promise<ProviderModel[]> {
    const provider = this.get(id);
    const llm = createProvider(provider);
    return llm.listModels();
  }

  async validate(id: string): Promise<{ valid: boolean; error?: string }> {
    const provider = this.get(id);
    const llm = createProvider(provider);
    return llm.validate();
  }
}
