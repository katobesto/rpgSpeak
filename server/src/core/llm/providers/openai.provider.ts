import type { LLMProvider, ProviderOptions } from '../provider.interface.js';
import type { GenerateRequest, GenerateResponse, ProviderModel } from '@rpgspeak/shared';
import { ProviderError } from '../../../shared/errors.js';

// ── Parser del endpoint /models ──────────────────────────────────────────────
// OpenRouter expone un esquema rico (pricing, architecture, supported_parameters,
// top_provider); los OpenAI-compatible "pelados" (DeepSeek, LM Studio, mlx…) solo
// devuelven { id, owned_by, created }. Todos los campos son opcionales: el parser
// lee lo que haya y degrada con gracia.
interface RawModelEntry {
  id: string;
  name?: string;
  description?: string;
  created?: number;
  context_length?: number;
  owned_by?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[]; tokenizer?: string };
  pricing?: { prompt?: string; completion?: string };
  top_provider?: { context_length?: number; max_completion_tokens?: number; is_moderated?: boolean };
  supported_parameters?: string[];
}

/** Precio por millón de tokens desde el precio-por-token (string) de OpenRouter. */
function pricePerMillion(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n * 1e6 : undefined;
}

function parseModelEntry(m: RawModelEntry): ProviderModel {
  const arch = m.architecture ?? {};
  const top  = m.top_provider ?? {};
  const supported = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextLength: m.context_length ?? top.context_length,
    description: m.description,
    promptPricePerM:     pricePerMillion(m.pricing?.prompt),
    completionPricePerM: pricePerMillion(m.pricing?.completion),
    maxCompletionTokens: top.max_completion_tokens,
    supportsReasoning:   supported.includes('reasoning') ? true : undefined,
    inputModalities:     Array.isArray(arch.input_modalities) ? arch.input_modalities : undefined,
    tokenizer:           arch.tokenizer,
    // OpenRouter no expone owned_by: el proveedor va en el prefijo del id
    // ("anthropic/claude-sonnet-5" → "anthropic"). Se deriva como fallback.
    ownedBy:             m.owned_by ?? (m.id.includes('/') ? m.id.split('/')[0] : undefined),
    created:             typeof m.created === 'number' ? m.created : undefined,
  };
}

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

  // LM Studio's Jinja chat templates only tolerate one 'system' message at
  // position 0 followed by strict user/assistant alternation. Our context
  // builder injects several 'system'-role footer blocks (scene coherence,
  // memories, affinity…) as separate messages — those cause the template to
  // throw "No user query found in messages."
  //
  // Fix: for lmstudio, merge all system messages into one at position 0.
  // Non-system messages keep their original relative order; content is unchanged.
  private normalizeMessages(messages: { role: string; content: string }[]): typeof messages {
    if (this.type !== 'lmstudio') return messages;

    const systemParts: string[] = [];
    const nonSystem: typeof messages = [];
    for (const msg of messages) {
      if (msg.role === 'system') systemParts.push(msg.content);
      else nonSystem.push(msg);
    }

    if (systemParts.length <= 1) return messages;
    return [{ role: 'system', content: systemParts.join('\n\n---\n\n') }, ...nonSystem];
  }

  private buildBody(request: GenerateRequest, stream: boolean) {
    const reasoning = request.reasoning?.enabled;
    // Los modelos híbridos de DeepSeek (p.ej. deepseek-v4-flash) tienen el thinking
    // activado por defecto en su API si el campo se omite — no basta con no enviar
    // el parámetro para desactivarlo, hay que mandar { type: 'disabled' } explícito.
    // Detectado por nombre de modelo: "thinking" no es un parámetro OpenAI estándar
    // y otros backends (OpenAI real, LM Studio, MLX, Oobabooga) pueden rechazarlo
    // si es un campo desconocido, así que no se envía fuera de DeepSeek.
    const isDeepSeek = /deepseek/i.test(request.model ?? '');
    return {
      model: request.model ?? '',
      messages: this.normalizeMessages(request.messages),
      stream,
      // Thinking mode (e.g. DeepSeek V4) ignores temperature/top_p/penalties anyway,
      // but omit them so the intent is explicit and providers don't warn about them.
      ...(reasoning ? {} : {
        temperature: request.temperature,
        top_p: request.topP,
        frequency_penalty: request.repetitionPenalty,
        presence_penalty: request.presencePenalty,
      }),
      // Si no hay límite explícito, enviamos -1 para LM Studio / OpenRouter que lo aceptan,
      // o lo omitimos si el valor es undefined (OpenAI real usa el máximo del modelo)
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      stop: request.stopSequences?.length ? request.stopSequences : undefined,
      // OpenRouter: prevent automatic fallback to alternative (potentially paid) providers.
      ...(request.disableFallbacks ? { allow_fallbacks: false } : {}),
      // DeepSeek V4 thinking mode
      ...(reasoning ? { thinking: { type: 'enabled' }, reasoning_effort: request.reasoning?.effort ?? 'high' }
        : isDeepSeek ? { thinking: { type: 'disabled' } }
        : {}),
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

    // LM Studio (and some other providers) expose reasoning content via
    // delta.reasoning_content instead of embedding <think> tags in delta.content.
    // We wrap it in synthetic <think>…</think> so engine.ts routeToken can handle it
    // identically to providers that do embed the tags (e.g. DeepSeek via Ollama).
    let reasoningOpen = false;

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
            choices: Array<{ delta: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
            usage?: {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens: number;
              prompt_tokens_details?: { cached_tokens?: number };
              prompt_cache_hit_tokens?: number;
            };
          };

          const delta = chunk.choices?.[0]?.delta;

          // Reasoning/thinking content (LM Studio, some OpenRouter models)
          const reasoningToken = delta?.reasoning_content;
          if (reasoningToken) {
            if (!reasoningOpen) {
              reasoningOpen = true;
              yield '<think>';
            }
            yield reasoningToken;
          }

          // Regular content — close any open <think> block first
          const token = delta?.content;
          if (token) {
            if (reasoningOpen) {
              reasoningOpen = false;
              yield '</think>';
            }
            totalContent += token;
            yield token;
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

    // Flush unclosed reasoning block (model stopped mid-think)
    if (reasoningOpen) yield '</think>';

    return {
      content: totalContent,
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
    const data = await res.json() as { data?: RawModelEntry[] };
    return (data.data ?? []).map(parseModelEntry);
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
