import type { LLMProvider, ProviderOptions } from '../provider.interface.js';
import type { GenerateRequest, GenerateResponse, ProviderModel } from '@rpgspeak/shared';
import { ProviderError } from '../../../shared/errors.js';

// Compatible with OpenAI, LM Studio, OpenRouter, and any OpenAI-compatible API
export class OpenAIProvider implements LLMProvider {
  readonly type: string;

  constructor(
    private readonly opts: ProviderOptions,
    type = 'openai'
  ) {
    this.type = type;
  }

  private get baseUrl() {
    return this.opts.baseUrl.replace(/\/$/, '');
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...this.opts.headers };
    if (this.opts.apiKey) h['Authorization'] = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  private buildBody(request: GenerateRequest, stream: boolean) {
    return {
      model: request.model ?? '',
      messages: request.messages,
      stream,
      temperature: request.temperature,
      // Si no hay límite explícito, enviamos -1 para LM Studio / OpenRouter que lo aceptan,
      // o lo omitimos si el valor es undefined (OpenAI real usa el máximo del modelo)
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      top_p: request.topP,
      frequency_penalty: request.repetitionPenalty,
      stop: request.stopSequences?.length ? request.stopSequences : undefined,
      // OpenRouter: prevent automatic fallback to alternative (potentially paid) providers.
      ...(request.disableFallbacks ? { allow_fallbacks: false } : {}),
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(this.buildBody(request, false)),
      // No timeout: generation can take as long as the model needs.
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(
          `Error de autenticación (${res.status}): revisa la "API Key" del provider en Ajustes → Providers. ` +
          `Si tu servidor no requiere clave (ej. mlx_lm.server sin --api-key), deja el campo vacío.`,
          this.type,
        );
      }
      if (res.status === 402) {
        throw new ProviderError(
          `Saldo insuficiente (402): tu cuenta no tiene créditos disponibles. ` +
          `Recarga el saldo en la web del proveedor (deepseek.com, openrouter.ai, etc.) e inténtalo de nuevo.`,
          this.type,
        );
      }
      const text = await res.text().catch(() => 'Unknown error');
      throw new ProviderError(`OpenAI-compatible error ${res.status}: ${text}`, this.type);
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        // OpenAI format
        prompt_tokens_details?: { cached_tokens?: number };
        // DeepSeek format
        prompt_cache_hit_tokens?: number;
      };
      model: string;
    };

    const u = data.usage;
    const cached =
      u?.prompt_tokens_details?.cached_tokens ??
      u?.prompt_cache_hit_tokens ??
      0;

    const choice = data.choices[0];
    return {
      content: choice.message.content,
      model: data.model ?? request.model,
      tokens: {
        prompt: u?.prompt_tokens ?? 0,
        completion: u?.completion_tokens ?? 0,
        total: u?.total_tokens ?? 0,
        cached,
      },
      finishReason: choice.finish_reason ?? 'stop',
    };
  }

  async *stream(request: GenerateRequest): AsyncGenerator<string, GenerateResponse, unknown> {
    // No timeout: the stream runs until the model finishes or the user cancels.
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(this.buildBody(request, true)),
    });

    if (!res.ok || !res.body) {
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(
          `Error de autenticación (${res.status}): revisa la "API Key" del provider en Ajustes → Providers. ` +
          `Si tu servidor no requiere clave (ej. mlx_lm.server sin --api-key), deja el campo vacío.`,
          this.type,
        );
      }
      if (res.status === 402) {
        throw new ProviderError(
          `Saldo insuficiente (402): tu cuenta no tiene créditos disponibles. ` +
          `Recarga el saldo en la web del proveedor (deepseek.com, openrouter.ai, etc.) e inténtalo de nuevo.`,
          this.type,
        );
      }
      const text = await res.text().catch(() => res.statusText);
      throw new ProviderError(`OpenAI-compatible stream error ${res.status}: ${text}`, this.type);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let totalContent = '';
    let usage = { prompt: 0, completion: 0, total: 0, cached: 0 };

    // Filter <think>...</think> blocks emitted by reasoning models (e.g. Qwen3).
    // Key insight: only hold back from a '<' that could still become '<think>' or
    // '</think>'. Normal text with no '<' is always yielded immediately, so there
    // is zero lag for non-thinking models.
    let inThink = false;
    let boundary = ''; // tiny buffer — only holds a partial tag candidate

    const filterToken = (token: string): string => {
      boundary += token;
      let out = '';

      while (boundary.length > 0) {
        const tag = inThink ? '</think>' : '<think>';

        const fullIdx = boundary.indexOf(tag);
        if (fullIdx !== -1) {
          // Complete tag found
          if (!inThink) out += boundary.slice(0, fullIdx); // text before <think>
          boundary = boundary.slice(fullIdx + tag.length);
          inThink = !inThink;
          continue; // re-process remainder
        }

        // No complete tag — find the leftmost '<' whose tail could still become
        // the target tag. Everything before that '<' is safe to emit.
        let holdFrom = boundary.length; // default: hold nothing back
        for (let i = 0; i < boundary.length; i++) {
          if (boundary[i] === '<') {
            const tail = boundary.slice(i);
            if (tag.startsWith(tail)) { // partial match — must wait
              holdFrom = i;
              break;
            }
          }
        }

        if (!inThink) out += boundary.slice(0, holdFrom);
        boundary = boundary.slice(holdFrom);
        break;
      }

      return out;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data) as {
              choices: Array<{ delta: { content?: string }; finish_reason?: string }>;
              usage?: {
                prompt_tokens: number;
                completion_tokens: number;
                total_tokens: number;
                prompt_tokens_details?: { cached_tokens?: number };
                prompt_cache_hit_tokens?: number;
              };
            };
            const token = chunk.choices?.[0]?.delta?.content;
            if (token) {
              totalContent += token;
              const output = filterToken(token);
              if (output) yield output;
            }
            if (chunk.usage) {
              const cu = chunk.usage;
              usage = {
                prompt: cu.prompt_tokens,
                completion: cu.completion_tokens,
                total: cu.total_tokens,
                cached:
                  cu.prompt_tokens_details?.cached_tokens ??
                  cu.prompt_cache_hit_tokens ??
                  0,
              };
            }
          } catch {
            // skip malformed chunk
          }
        }
      }
    } finally {
      // nothing to clean up
    }

    // Flush any remaining boundary buffer (only if not inside a think block)
    if (!inThink && boundary) yield boundary;

    // Strip any think blocks from the full accumulated content for the saved message
    const cleanContent = totalContent.replace(/<think>[\s\S]*?<\/think>/g, '').trimStart();

    return {
      content: cleanContent,
      model: request.model ?? '',
      tokens: { prompt: usage.prompt, completion: usage.completion, total: usage.total, cached: usage.cached },
      finishReason: 'stop',
    };
  }

  async embed(texts: string[], model?: string): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ model: model ?? '', input: texts }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`OpenAI embeddings error ${res.status}: ${text}`, this.type);
    }
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }

  async listModels(): Promise<ProviderModel[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(
        `Error de autenticación (${res.status}): revisa la "API Key" del provider en Ajustes → Providers. ` +
        `Si tu servidor no requiere clave (ej. mlx_lm.server sin --api-key), deja el campo vacío.`,
        this.type,
      );
    }
    if (!res.ok) return [];
    const data = await res.json() as { data: Array<{ id: string }> };
    return (data.data ?? []).map((m) => ({ id: m.id, name: m.id }));
  }

  async validate(): Promise<{ valid: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 401 || res.status === 403) {
        return {
          valid: false,
          error: `Autenticación fallida (${res.status}). Revisa la "API Key" del provider. ` +
                 `Si tu servidor no requiere clave (ej. mlx_lm.server sin --api-key), déjala vacía.`,
        };
      }
      if (!res.ok) {
        return { valid: false, error: `El servidor respondió con HTTP ${res.status}. Verifica la URL base.` };
      }
      return { valid: true };
    } catch {
      return { valid: false, error: 'No se pudo conectar. Verifica que el servidor esté activo y la URL sea correcta.' };
    }
  }
}
