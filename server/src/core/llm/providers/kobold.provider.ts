import type { LLMProvider, ProviderOptions } from '../provider.interface.js';
import type { GenerateRequest, GenerateResponse, ProviderModel } from '@rpgspeak/shared';
import { ProviderError } from '../../../shared/errors.js';

// Compatible with KoboldCpp and Oobabooga (both support OpenAI-compatible + native API)
export class KoboldProvider implements LLMProvider {
  readonly type = 'kobold';

  constructor(private readonly opts: ProviderOptions) {}

  private get baseUrl() {
    return this.opts.baseUrl.replace(/\/$/, '');
  }

  private buildPrompt(messages: GenerateRequest['messages']): string {
    return messages
      .map((m) => {
        if (m.role === 'system') return `### System:\n${m.content}\n`;
        if (m.role === 'user') return `### User:\n${m.content}\n`;
        return `### Assistant:\n${m.content}\n`;
      })
      .join('\n') + '### Assistant:\n';
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const body = {
      prompt: this.buildPrompt(request.messages),
      max_length: request.maxTokens ?? 512,
      temperature: request.temperature ?? 0.8,
      top_p: request.topP ?? 0.9,
      top_k: request.topK ?? 40,
      rep_pen: request.repetitionPenalty ?? 1.1,
      stop_sequence: request.stopSequences ?? [],
    };

    const res = await fetch(`${this.baseUrl}/api/v1/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // No timeout: generation runs until the model finishes.
    });

    if (!res.ok) {
      throw new ProviderError(`KoboldCpp error ${res.status}`, this.type);
    }

    const data = await res.json() as { results: Array<{ text: string }> };
    const content = data.results?.[0]?.text ?? '';

    return {
      content,
      model: request.model ?? '',
      tokens: { prompt: 0, completion: 0, total: 0 },
      finishReason: 'stop',
    };
  }

  async *stream(request: GenerateRequest): AsyncGenerator<string, GenerateResponse, unknown> {
    // KoboldCpp supports SSE streaming via /api/extra/generate/stream
    const body = {
      prompt: this.buildPrompt(request.messages),
      max_length: request.maxTokens ?? 512,
      temperature: request.temperature ?? 0.8,
      top_p: request.topP ?? 0.9,
      top_k: request.topK ?? 40,
      rep_pen: request.repetitionPenalty ?? 1.1,
    };

    const res = await fetch(`${this.baseUrl}/api/extra/generate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // No timeout: stream runs until the model finishes or the user cancels.
    });

    if (!res.ok || !res.body) {
      // Fallback to non-streaming
      const result = await this.generate(request);
      yield result.content;
      return result;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const chunk = JSON.parse(line.slice(6)) as { token: string };
          if (chunk.token) {
            totalContent += chunk.token;
            yield chunk.token;
          }
        } catch {
          // skip
        }
      }
    }

    return {
      content: totalContent,
      model: request.model ?? '',
      tokens: { prompt: 0, completion: 0, total: 0 },
      finishReason: 'stop',
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/model`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return [];
      const data = await res.json() as { result: string };
      return [{ id: data.result, name: data.result }];
    } catch {
      return [];
    }
  }

  async validate(): Promise<{ valid: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/info`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return { valid: false, error: `Error HTTP ${res.status}. Verifica la URL del servidor KoboldAI.` };
      return { valid: true };
    } catch {
      return { valid: false, error: 'No se pudo conectar a KoboldAI. Verifica que el servidor esté activo.' };
    }
  }
}
