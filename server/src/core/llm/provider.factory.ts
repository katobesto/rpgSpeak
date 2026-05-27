import type { LLMProvider } from './provider.interface.js';
import { OllamaProvider } from './providers/ollama.provider.js';
import { OpenAIProvider } from './providers/openai.provider.js';
import { KoboldProvider } from './providers/kobold.provider.js';
import type { Provider } from '@rpgspeak/shared';
import { ProviderError } from '../../shared/errors.js';

const cache = new Map<string, LLMProvider>();

export function createProvider(provider: Provider): LLMProvider {
  const cacheKey = `${provider.id}-${provider.updatedAt}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const opts = {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey ?? undefined,
    timeout: (provider.config as { timeout?: number }).timeout,
    headers: (provider.config as { headers?: Record<string, string> }).headers,
  };

  let instance: LLMProvider;

  switch (provider.type) {
    case 'ollama':
      instance = new OllamaProvider(opts);
      break;
    case 'openai':
      instance = new OpenAIProvider(opts, 'openai');
      break;
    case 'lmstudio':
      instance = new OpenAIProvider(opts, 'lmstudio');
      break;
    case 'mlx':
      // mlx-lm server exposes an OpenAI-compatible API (mlx_lm.server)
      instance = new OpenAIProvider(opts, 'mlx');
      break;
    case 'openrouter':
      instance = new OpenAIProvider(
        { ...opts, headers: { ...opts.headers, 'HTTP-Referer': 'http://localhost:3000' } },
        'openrouter'
      );
      break;
    case 'kobold':
      instance = new KoboldProvider(opts);
      break;
    case 'oobabooga':
      // Oobabooga supports OpenAI-compatible API by default
      instance = new OpenAIProvider(opts, 'oobabooga');
      break;
    case 'custom':
      instance = new OpenAIProvider(opts, 'custom');
      break;
    default:
      throw new ProviderError(`Unknown provider type: ${provider.type}`);
  }

  cache.set(cacheKey, instance);
  return instance;
}

export function invalidateProviderCache(providerId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(providerId)) cache.delete(key);
  }
}
