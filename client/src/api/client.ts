const BASE = '/api';

class ApiError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem('rpgspeak_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // For FormData let the browser set Content-Type (includes multipart boundary)
  const hasJsonBody = init?.body !== undefined && !(init.body instanceof FormData);
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...getAuthHeader(),
      ...init?.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const json = await res.json().catch(() => ({ success: false, message: res.statusText }));

  if (!res.ok) {
    throw new ApiError(res.status, json.message ?? 'Request failed');
  }

  return (json as { data: T }).data;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  postForm: <T>(path: string, body: FormData) =>
    request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (path: string) => request<void>(path, { method: 'DELETE' }),
  deleteWithBody: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'DELETE', body: JSON.stringify(body) }),
};

export { ApiError };

// ─── SSE streaming helper ─────────────────────────────────────────────────────

export interface AffinityUpdate {
  characterId: string;
  newAffinity: number;
}

export interface TokenBreakdown {
  prompt: number;
  completion: number;
  cached: number;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onDone: (result: { messageId: string; tokens: number; tokenBreakdown?: TokenBreakdown; promptMessages?: unknown[]; affinityUpdates?: AffinityUpdate[]; fastLlmDebug?: string; narrator?: boolean; characterId?: string | null; content?: string }) => void;
  onError: (err: Error) => void;
}

export async function streamGenerate(
  body: {
    conversationId: string;
    message: string;
    characterId?: string;
    branchId?: string;
    narratorMode?: boolean;
    overrides?: { temperature?: number; maxTokens?: number; model?: string };
  },
  callbacks: StreamCallbacks
): Promise<() => void> {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${BASE}/generate/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Stream error: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type: 'token' | 'done' | 'error';
              token?: string;
              messageId?: string;
              tokens?: number;
              tokenBreakdown?: TokenBreakdown;
              promptMessages?: unknown[];
              affinityUpdates?: AffinityUpdate[];
              fastLlmDebug?: string;
              narrator?: boolean;
              characterId?: string | null;
              content?: string;
              error?: string;
            };

            if (event.type === 'token' && event.token) {
              callbacks.onToken(event.token);
            } else if (event.type === 'done') {
              callbacks.onDone({ messageId: event.messageId!, tokens: event.tokens!, tokenBreakdown: event.tokenBreakdown, promptMessages: event.promptMessages, affinityUpdates: event.affinityUpdates, fastLlmDebug: event.fastLlmDebug, narrator: event.narrator, characterId: event.characterId, content: event.content });
            } else if (event.type === 'error') {
              callbacks.onError(new Error(event.error ?? 'Unknown stream error'));
            }
          } catch {
            // skip malformed
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return () => controller.abort();
}
