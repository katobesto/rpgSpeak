import { api } from './client.ts';
import type { Character, CreateCharacterDto, UpdateCharacterDto } from '@rpgspeak/shared';

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
    api.post<Character>(`/characters/${id}/generate-scene-image`, opts),
};
