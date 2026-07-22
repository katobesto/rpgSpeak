import { api } from './client.ts';
import type { Character, CreateCharacterDto, UpdateCharacterDto } from '@rpgspeak/shared';

export type CharacterSceneImageSseEvent =
  | { type: 'status';   message: string }
  | { type: 'node';     nodeId: string; nodeName: string }
  | { type: 'progress'; value: number; max: number }
  | { type: 'preview';  dataUrl: string }
  | { type: 'done';     imageUrl: string; generatedPrompt: string }
  | { type: 'error';    message: string };

export const charactersApi = {
  list: (search?: string, storyId?: string) => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (storyId) params.set('storyId', storyId);
    const qs = params.toString();
    return api.get<Character[]>(`/characters${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => api.get<Character>(`/characters/${id}`),
  create: (data: CreateCharacterDto) => api.post<Character>('/characters', data),
  update: (id: string, data: UpdateCharacterDto) => api.patch<Character>(`/characters/${id}`, data),
  delete: (id: string) => api.delete(`/characters/${id}`),
  duplicate: (id: string) => api.post<Character>(`/characters/${id}/duplicate`, {}),
  import: (data: CreateCharacterDto) => api.post<Character>('/characters/import', data),
  generateImageDescription: (id: string, overrides?: { providerId?: string; modelId?: string }) =>
    api.post<{ description: string }>(`/characters/${id}/generate-description`, overrides ?? {}),
  addImage: (id: string, file: File, setAsAvatar?: boolean) => {
    const formData = new FormData();
    formData.append('file', file);
    const qs = setAsAvatar ? '?setAsAvatar=true' : '';
    return api.postForm<Character>(`/characters/${id}/images${qs}`, formData);
  },
  removeImage: (id: string, imagePath: string) =>
    api.deleteWithBody<Character>(`/characters/${id}/images`, { path: imagePath }),
  generateComfyImage: (id: string, workflowName?: string) =>
    api.post<Character>(`/characters/${id}/generate-comfy`, { workflowName }),
  generateSceneImage: (id: string, opts: { scenePrompt: string; providerId?: string; modelId?: string; workflowName?: string }) =>
    api.post<{ character: Character; generatedPrompt: string }>(`/characters/${id}/generate-scene-image`, opts),
  /** Opens an SSE stream for gallery scene-image generation. Returns a cleanup function. */
  streamSceneImage: (
    id: string,
    opts: { scenePrompt: string; providerId?: string; modelId?: string; workflowName?: string },
    onEvent: (evt: CharacterSceneImageSseEvent) => void,
  ): (() => void) => {
    const controller = new AbortController();

    (async () => {
      try {
        const token = localStorage.getItem('rpgspeak_token');
        const res = await fetch(`/api/characters/${id}/generate-scene-image-sse`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(opts),
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
              const evt = JSON.parse(line.slice(6)) as CharacterSceneImageSseEvent;
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
  },
};
