import type { LLMProvider, ProviderOptions } from '../provider.interface.js';
import type { GenerateRequest, GenerateResponse, ProviderModel } from '@rpgspeak/shared';
import { ProviderError } from '../../../shared/errors.js';
import { normalizeStrictTemplateMessages } from '../normalize-messages.js';

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

// ── Esfuerzo de razonamiento por familia de modelo ──────────────────────────
// Cada familia reporta/acepta un conjunto distinto de valores en
// `reasoning_effort`; enviar uno que el modelo no reconoce hace que el
// servidor de inferencia falle (p.ej. la chat template de Qwen lanza
// "Unexpected reasoning effort" con 'high'/'max'):
//   • DeepSeek (V4, modo thinking): solo 'high' | 'max'.
//   • Qwen: 'low' | 'medium' | 'xhigh' (xhigh es el default de su template).
//   • Resto (OpenAI, OpenRouter, LM Studio, llama.cpp, vLLM…): estándar
//     OpenAI 'low' | 'medium' | 'high'.
// El esfuerzo configurado se recorta al conjunto de la familia antes de enviar.
type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

function effortFamily(model: string | undefined): { allowed: ReasoningEffort[]; default: ReasoningEffort } {
  const id = model ?? '';
  if (/deepseek/i.test(id)) return { allowed: ['high', 'max'], default: 'high' };
  if (/qwen/i.test(id))     return { allowed: ['low', 'medium', 'xhigh'], default: 'xhigh' };
  return { allowed: ['low', 'medium', 'high'], default: 'high' };
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

  // Templates estrictos: un sistema inicial y alternancia user/assistant.
  // Los sistemas tardíos se adjuntan al siguiente user EN SU POSICIÓN, nunca
  // a la cabecera: subir el estado cambiante invalidaba todo el prefix-cache.
  // Aplica a todo backend local que aplique la plantilla HF del modelo
  // (lmstudio, custom/llama.cpp, mlx, oobabooga). OpenAI y OpenRouter sí
  // aceptan system en cualquier posición y se dejan intactos.
  private normalizeMessages(messages: { role: string; content: string }[]): typeof messages {
    if (!['lmstudio', 'custom', 'mlx', 'oobabooga'].includes(this.type)) return messages;
    return normalizeStrictTemplateMessages(messages);
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
    // Esfuerzo recortado al conjunto que la familia del modelo reporta como
    // válido (ver effortFamily) — evita errores 4xx/5xx en servidores que no
    // reconocen el valor guardado (p.ej. 'max' en Qwen).
    const family = effortFamily(request.model);
    const configuredEffort = request.reasoning?.effort;
    const safeEffort =
      configuredEffort && family.allowed.includes(configuredEffort)
        ? configuredEffort
        : family.default;
    return {
      model: request.model ?? '',
      messages: this.normalizeMessages(request.messages),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      // DeepSeek thinking y OpenAI reasoning no admiten los mismos controles
      // que los backends locales. No desactivarlos para Qwen/LM Studio/MLX.
      ...(reasoning && (isDeepSeek || this.type === 'openai') ? {} : {
        temperature: request.temperature,
        top_p: request.topP,
        frequency_penalty: request.frequencyPenalty,
        presence_penalty: request.presencePenalty,
        ...(this.type === 'lmstudio' ? { repeat_penalty: request.repetitionPenalty } : {}),
        ...(['openrouter', 'mlx', 'oobabooga'].includes(this.type)
          ? { repetition_penalty: request.repetitionPenalty } : {}),
        ...(['openrouter', 'lmstudio', 'mlx', 'oobabooga'].includes(this.type)
          ? { top_k: request.topK } : {}),
      }),
      // Si no hay límite explícito, enviamos -1 para LM Studio / OpenRouter que lo aceptan,
      // o lo omitimos si el valor es undefined (OpenAI real usa el máximo del modelo)
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      stop: request.stopSequences?.length ? request.stopSequences : undefined,
      // OpenRouter: prevent automatic fallback to alternative (potentially paid) providers.
      ...(this.type === 'openrouter' && request.disableFallbacks ? { provider: { allow_fallbacks: false } } : {}),
      // Thinking / razonamiento según la familia del modelo:
      //  • 'thinking' es un campo EXCLUSIVO de DeepSeek — enviarlo a otros
      //    servidores de inferencia (OpenRouter, LM Studio, llama.cpp, vLLM…)
      //    provoca error por parámetro desconocido.
      //  • 'reasoning_effort' es el parámetro estándar OpenAI; su valor se
      //    recorta a lo que la familia del modelo reporta (ver effortFamily).
      ...(reasoning
        ? { ...(isDeepSeek ? { thinking: { type: 'enabled' } } : {}), reasoning_effort: safeEffort }
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
