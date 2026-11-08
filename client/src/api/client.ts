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

/** Called by the 401 interceptor below — clears stored credentials without
 *  importing the Zustand store (avoids circular deps) and dispatches an event
 *  so App.tsx can react and show the login screen immediately. */
function handleUnauthorized(): void {
  localStorage.removeItem('rpgspeak_token');
  localStorage.removeItem('rpgspeak_user');
  // Signal App-level listeners so the React tree re-evaluates isAuthenticated
  window.dispatchEvent(new Event('rpgspeak:unauthorized'));
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

  // Se lee como texto y se parsea a mano: así una respuesta NO JSON (página de
  // error de Cloudflare, HTML del SPA cuando la ruta de API no existe, cuerpo
  // vacío) se convierte en un mensaje útil en lugar de un `undefined` silencioso.
  const raw = await res.text();
  let json: unknown = null;
  let parseFailed = false;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    parseFailed = true;
  }

  const bodyMessage =
    json && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string'
      ? (json as { message: string }).message.trim()
      : '';

  if (!res.ok) {
    if (res.status === 401) {
      // Token missing, expired, or signed with a different secret (e.g. fresh DB).
      // Clear credentials so the app falls back to the login screen on next render.
      handleUnauthorized();
    }
    // El status SIEMPRE va en el mensaje: en HTTP/2 `res.statusText` viene vacío,
    // y sin él un fallo del proxy se quedaba sin nada que mostrar al usuario.
    const detail =
      bodyMessage ||
      (raw.trim() ? `respuesta no esperada: ${raw.trim().slice(0, 180)}` : 'el servidor no dio detalle');
    throw new ApiError(res.status, `${res.status} en ${init?.method ?? 'GET'} ${path} — ${detail}`);
  }

  // 200 con cuerpo que no es JSON: típico de una ruta de API que no existe y
  // acaba en el fallback del SPA (index.html) o de un error interceptado por el
  // proxy. Antes esto se devolvía como `undefined` y el guardado parecía OK.
  if (parseFailed) {
    throw new ApiError(
      res.status,
      `${res.status} en ${init?.method ?? 'GET'} ${path} — el servidor respondió algo que no es JSON` +
        ` (empezaba con: ${raw.trim().slice(0, 80) || 'cuerpo vacío'})`,
    );
  }

  if (json === null) return undefined as T;   // 200 con cuerpo vacío

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
  delete: <T = void>(path: string) => request<T>(path, { method: 'DELETE' }),
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

/** Un paso del enriquecimiento de fondo tras generar la respuesta (director de
 *  escena, resúmenes, anclaje del mundo…). `index` es 1-based. */
export interface EnrichStep {
  index: number;
  total: number;
  label: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onThinkToken?: (token: string) => void;
  /** Llega ANTES de que empiecen a fluir tokens, cuando el árbitro dedicado de
   *  tiradas (servidor) ya resolvió el dado para este turno. El store debe
   *  abrir el modal YA y retener el texto que va a llegar por onToken —
   *  si no, el jugador ve el desenlace en el streaming antes de que el modal
   *  siquiera aparezca. */
  onDicePending?: (diceRoll: import('@rpgspeak/shared').DiceRollResult) => void;
  onDone: (result: { messageId: string; userMessageId: string; tokens: number; tokenBreakdown?: TokenBreakdown; promptMessages?: unknown[]; affinityUpdates?: AffinityUpdate[]; fastLlmDebug?: string; narrator?: boolean; characterId?: string | null; content?: string; locationUpdate?: string | null; thinkContent?: string; deathLoop?: import('@rpgspeak/shared').DeathLoopState | null; diceRoll?: import('@rpgspeak/shared').DiceRollResult }) => void;
  /** El mensaje ya es visible e interactivo (onDone ya se llamó); esto informa
   *  de las llamadas de fondo al LLM que siguen en curso (director de escena,
   *  resúmenes...). Solo llega cuando de verdad hay un paso pendiente. */
  onEnrichStep?: (step: EnrichStep) => void;
  /** Fin de la pasada de enriquecimiento (incluso si no hubo ningún paso).
   *  `bgTokens` = coste real de fondo del turno, solo si hubo llamadas. */
  onEnrichDone?: (info?: { bgTokens?: import('@rpgspeak/shared').BackgroundTokenUsage }) => void;
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
        if (res.status === 401) handleUnauthorized();
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
              type: 'token' | 'think' | 'done' | 'enrich_step' | 'enrich_done' | 'dice_pending' | 'error';
              token?: string;
              messageId?: string;
              userMessageId?: string;
              tokens?: number;
              tokenBreakdown?: TokenBreakdown;
              promptMessages?: unknown[];
              affinityUpdates?: AffinityUpdate[];
              fastLlmDebug?: string;
              narrator?: boolean;
              characterId?: string | null;
              content?: string;
              locationUpdate?: string | null;
              deathLoop?: import('@rpgspeak/shared').DeathLoopState | null;
              diceRoll?: import('@rpgspeak/shared').DiceRollResult;
              bgTokens?: import('@rpgspeak/shared').BackgroundTokenUsage;
              thinkContent?: string;
              index?: number;
              total?: number;
              label?: string;
              error?: string;
            };

            if (event.type === 'token' && event.token) {
              callbacks.onToken(event.token);
            } else if (event.type === 'think' && event.token) {
              callbacks.onThinkToken?.(event.token);
            } else if (event.type === 'done') {
              callbacks.onDone({ messageId: event.messageId!, userMessageId: event.userMessageId!, tokens: event.tokens!, tokenBreakdown: event.tokenBreakdown, promptMessages: event.promptMessages, affinityUpdates: event.affinityUpdates, fastLlmDebug: event.fastLlmDebug, narrator: event.narrator, characterId: event.characterId, content: event.content, locationUpdate: event.locationUpdate, thinkContent: event.thinkContent, deathLoop: event.deathLoop, diceRoll: event.diceRoll });
            } else if (event.type === 'enrich_step') {
              callbacks.onEnrichStep?.({ index: event.index!, total: event.total!, label: event.label ?? '' });
            } else if (event.type === 'enrich_done') {
              callbacks.onEnrichDone?.(event.bgTokens ? { bgTokens: event.bgTokens } : undefined);
            } else if (event.type === 'dice_pending' && event.diceRoll) {
              callbacks.onDicePending?.(event.diceRoll);
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
