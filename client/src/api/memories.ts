import { api } from './client.ts';
import type { MemoryEntry } from '@rpgspeak/shared';

export const memoriesApi = {
  list: (conversationId: string, characterId?: string) =>
    api.get<MemoryEntry[]>(
      `/memories?conversationId=${encodeURIComponent(conversationId)}${characterId ? `&characterId=${encodeURIComponent(characterId)}` : ''}`
    ),

  create: (data: {
    conversationId: string;
    characterId: string;
    type: MemoryEntry['type'];
    content: string;
    importance: number;
  }) => api.post<MemoryEntry>('/memories', data),

  deactivate: (id: string) => api.delete(`/memories/${id}`),
};
