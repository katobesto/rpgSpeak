import { api } from './client.ts';
import type { StoryChapter } from '@rpgspeak/shared';

export const chaptersApi = {
  list:     (conversationId: string) =>
    api.get<StoryChapter[]>(`/chapters/${conversationId}`),

  generate: (conversationId: string) =>
    api.post<StoryChapter[]>('/chapters/generate', { conversationId }),

  complete: (chapterId: string, conversationId: string) =>
    api.post<{ completed: StoryChapter; next: StoryChapter | null } | null>(
      `/chapters/${chapterId}/complete`,
      { conversationId },
    ),

  /** Cambia el estado de un capítulo: completado, pendiente o activo */
  setAction: (chapterId: string, action: 'complete' | 'uncomplete' | 'activate') =>
    api.patch<{ success: boolean }>(`/chapters/${chapterId}`, { action }),

  deleteAll: (conversationId: string) =>
    api.delete(`/chapters/${conversationId}`),
};
