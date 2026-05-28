import type { LLMProvider, ProviderOptions } from '../provider.interface.js';
import type { GenerateRequest, GenerateResponse, ProviderModel } from '@rpgspeak/shared';
import { ProviderError } from '../../../shared/errors.js';

interface OllamaMessage {
  role: string;
  content: string;
}

interface OllamaChatResponse {
  message: OllamaMessage;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

interface OllamaModel {
  name: string;
  details?: { parameter_size?: string };
}

export class OllamaProvider implements LLMProvider {
  readonly type = 'ollama';

  constructor(private readonly opts: ProviderOptions) {}

  private get baseUrl() {
    return this.opts.baseUrl.replace(/\/$/, '');
  }

  private async fetchJson<T>(path: string, options?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const { timeoutMs, ...rest } = options ?? {};
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...rest,
      headers: { 'Content-Type': 'application/json', ...this.opts.headers, ...rest?.headers },
      // Only apply a signal when an explicit timeout is requested (health checks).
      // Generation calls pass no timeoutMs → no timeout.
      ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error');
      throw new ProviderError(`Ollama error ${res.status}: ${text}`, this.type);
    }
    return res.json() as T;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const body = {
      model: request.model ?? '',
      messages: request.messages,
      stream: false,
      options: {
        temperature: request.temperature,
        top_p: request.topP,
        top_k: request.topK,
        repeat_penalty: request.repetitionPenalty,
        num_predict: request.maxTokens ?? -1,
        num_ctx: request.contextSize ?? 32768,
        stop: request.stopSequences,
      },
    };

    const data = await this.fetchJson<OllamaChatResponse>('/api/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return {
      content: data.message.content,
      model: request.model ?? '',
      tokens: {
        prompt: data.prompt_eval_count ?? 0,
        completion: data.eval_count ?? 0,
        total: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
      finishReason: data.done_reason ?? 'stop',
    };
  }

  async *stream(request: GenerateRequest): AsyncGenerator<string, GenerateResponse, unknown> {
    const body = {
      model: request.model ?? '',
      messages: request.messages,
      stream: true,
      options: {
        temperature: request.temperature,
        top_p: request.topP,
        top_k: request.topK,
        repeat_penalty: request.repetitionPenalty,
        num_predict: request.maxTokens ?? -1,
        num_ctx: request.contextSize ?? 32768,
        stop: request.stopSequences,
      },
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.opts.headers },
      body: JSON.stringify(body),
      // No timeout: stream runs until the model finishes or the user cancels.
    });

    if (!res.ok || !res.body) {
      throw new ProviderError(`Ollama stream error ${res.status}`, this.type);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let finalResponse: GenerateResponse | null = null;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as OllamaChatResponse;
          if (chunk.message?.content) {
            yield chunk.message.content;
          }
          if (chunk.done) {
            finalResponse = {
              content: '',
              model: request.model ?? '',
              tokens: {
                prompt: chunk.prompt_eval_count ?? 0,
                completion: chunk.eval_count ?? 0,
                total: (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
              },
              finishReason: chunk.done_reason ?? 'stop',
            };
          }
        } catch {
          // malformed chunk, skip
        }
      }
    }

    return finalResponse ?? { content: '', model: request.model ?? '', tokens: { prompt: 0, completion: 0, total: 0 }, finishReason: 'stop' };
  }

  async embed(texts: string[], model?: string): Promise<number[][]> {
    const m = model ?? '';
    // Try modern Ollama API first (≥ 0.1.26): POST /api/embed with { model, input }
    try {
      const data = await this.fetchJson<{ embeddings: number[][] }>('/api/embed', {
        method: 'POST',
        body: JSON.stringify({ model: m, input: texts }),
      });
      if (Array.isArray(data.embeddings) && data.embeddings.length > 0) {
        return data.embeddings;
      }
    } catch { /* fall through to legacy API */ }

    // Legacy Ollama API (pre-0.1.26): POST /api/embeddings with { model, prompt }, one at a time
    const results: number[][] = [];
    for (const text of texts) {
      const data = await this.fetchJson<{ embedding: number[] }>('/api/embeddings', {
        method: 'POST',
        body: JSON.stringify({ model: m, prompt: text }),
      });
      results.push(data.embedding);
    }
    return results;
  }

  async listModels(): Promise<ProviderModel[]> {
    try {
      const data = await this.fetchJson<{ models: OllamaModel[] }>('/api/tags', { timeoutMs: 10_000 });
      return (data.models ?? []).map((m) => ({
        id: m.name,
        name: m.name,
        description: m.details?.parameter_size,
      }));
    } catch {
      return [];
    }
  }

  async validate(): Promise<{ valid: boolean; error?: string }> {
    try {
      await this.fetchJson('/api/tags', { timeoutMs: 5_000 });
      return { valid: true };
    } catch {
      return { valid: false, error: 'No se pudo conectar a Ollama. Verifica que el servidor esté activo.' };
    }
  }
}
