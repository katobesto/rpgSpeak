import { api } from './client.ts';
import type { Story, CreateStoryDto, UpdateStoryDto } from '@rpgspeak/shared';

export const storiesApi = {
  list: (search?: string, characterId?: string) => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (characterId) params.set('characterId', characterId);
    const qs = params.toString();
    return api.get<Story[]>(`/stories${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => api.get<Story>(`/stories/${id}`),
  create: (data: CreateStoryDto) => api.post<Story>('/stories', data),
  update: (id: string, data: UpdateStoryDto) => api.patch<Story>(`/stories/${id}`, data),
  delete: (id: string) => api.delete(`/stories/${id}`),
};
