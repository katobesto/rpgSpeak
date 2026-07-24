import { api } from './client.ts';
import type { ConversationNote } from '@rpgspeak/shared';

export const notesApi = {
  /** Todas las notas de la conversación, en orden de inyección. */
  list: (conversationId: string) =>
    api.get<ConversationNote[]>(`/notes/${encodeURIComponent(conversationId)}`),

  create: (conversationId: string, content: string) =>
    api.post<ConversationNote>('/notes', { conversationId, content }),

  update: (id: string, content: string) =>
    api.patch<ConversationNote>(`/notes/${id}`, { content }),

  delete: (id: string) => api.delete(`/notes/${id}`),

  /** Nuevo orden completo tras arrastrar en la UI. */
  reorder: (conversationId: string, orderedIds: string[]) =>
    api.patch<ConversationNote[]>('/notes/reorder', { conversationId, orderedIds }),
};
