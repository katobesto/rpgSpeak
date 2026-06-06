import { api, getAuthHeader } from './client.ts';

export type SceneImageSseEvent =
  | { type: 'status';        message: string }
  | { type: 'node';          nodeId: string; nodeName: string }
  | { type: 'progress';      value: number; max: number }
  | { type: 'latentPreview'; dataUrl: string }
  | { type: 'preview';       imageUrl: string; sceneDescription: string }
  | { type: 'done';          imageUrl: string; sceneDescription: string }
  | { type: 'error';         message: string };

/** Opens an SSE stream for scene-image generation. Returns a cleanup function. */
export function streamSceneImage(
  body: {
    conversationId: string;
    messageId: string;
    workflowName?: string;
    customPrompt?: string;
    useFaceReference?: boolean;
    referenceCharId?: string;
  },
  onEvent: (evt: SceneImageSseEvent) => void,
): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const token = localStorage.getItem('rpgspeak_token');
      const res = await fetch('/api/generate/scene-image-sse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        onEvent({ type: 'error', message: `HTTP ${res.status}` });
        return;
      }

      const reader  = res.body.getReader();
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
            const evt = JSON.parse(line.slice(6)) as SceneImageSseEvent;
            onEvent(evt);
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }
  })();

  return () => controller.abort();
}

export const generateApi = {
  sceneImage: (
    conversationId: string,
    messageId: string,
    workflowName?: string,
    customPrompt?: string,
    useFaceReference?: boolean,
    referenceCharId?: string,
  ) =>
    api.post<{ imageUrl: string; sceneDescription: string; pending?: boolean }>('/generate/scene-image', {
      conversationId,
      messageId,
      workflowName,
      customPrompt,
      useFaceReference,
      referenceCharId,
    }),

  deleteSceneImage: (conversationId: string, messageId: string) =>
    api.deleteWithBody<{ success: true }>('/generate/scene-image', { conversationId, messageId }),

  /** Sube una imagen externa y la asocia al mensaje (mismo campo sceneImageUrl). */
  uploadSceneImage: async (conversationId: string, messageId: string, file: File): Promise<{ imageUrl: string }> => {
    const form = new FormData();
    form.append('image', file);
    const resp = await fetch(
      `/api/generate/upload-scene-image?conversationId=${encodeURIComponent(conversationId)}&messageId=${encodeURIComponent(messageId)}`,
      { method: 'POST', headers: { ...getAuthHeader() }, body: form },
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(String(err.error ?? 'Error al subir la imagen'));
    }
    const data = await resp.json() as { success: boolean; data: { imageUrl: string } };
    return data.data;
  },

  /** Returns the raw prompt that would be sent to the LLM (without calling it). */
  buildScenePrompt: (
    conversationId: string,
    messageId: string,
    selectedCharacterIds?: string[],
    includeUser?: boolean,
    messageCount?: number,
  ) =>
    api.post<{ scenePrompt: string }>('/generate/build-scene-prompt', {
      conversationId,
      messageId,
      selectedCharacterIds,
      includeUser,
      messageCount,
    }),

  /** Calls the default LLM with the given prompt and returns the text result. */
  runLlmPrompt: (prompt: string) =>
    api.post<{ result: string }>('/generate/run-llm-prompt', { prompt }),

  /** Re-runs the fast-LLM analysis for an existing assistant message (retry after timeout). */
  analyzeMessage: (messageId: string) =>
    api.post<{ rawResponse: string; rawPrompt: string; affinityUpdates: { characterId: string; newAffinity: number }[] }>(
      '/generate/analyze',
      { messageId },
    ),
};
