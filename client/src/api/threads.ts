import { api } from './client.ts';
import type { NarrativeThread } from '@rpgspeak/shared';

export const threadsApi = {
  /** Todos los hilos de la conversación, abiertos y cerrados. */
  list: (conversationId: string) =>
    api.get<NarrativeThread[]>(`/threads/${encodeURIComponent(conversationId)}`),

  update: (
    id: string,
    data: {
      title?: string;
      description?: string;
      importance?: number;
      status?: 'open' | 'closed';
    },
  ) => api.patch<NarrativeThread>(`/threads/${id}`, data),

  close:  (id: string) => threadsApi.update(id, { status: 'closed' }),
  reopen: (id: string) => threadsApi.update(id, { status: 'open' }),

  delete: (id: string) => api.delete(`/threads/${id}`),
};
