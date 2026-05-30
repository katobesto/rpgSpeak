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

  deleteAll: (conversationId: string) =>
    api.delete(`/chapters/${conversationId}`),
};
