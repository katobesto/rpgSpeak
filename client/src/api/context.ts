import { api } from './client.ts';
import type { ContextItem, ContextExtractResult } from '@rpgspeak/shared';

export const contextApi = {
  list: (conversationId: string) =>
    api.get<ContextItem[]>(`/context?conversationId=${encodeURIComponent(conversationId)}`),

  extract: (conversationId: string, batchStart: number) =>
    api.post<ContextExtractResult>('/context/extract', { conversationId, batchStart }),

  update: (id: string, data: { title?: string; description?: string; importance?: number }) =>
    api.patch<ContextItem>(`/context/${id}`, data),

  delete: (id: string) =>
    api.delete(`/context/${id}`),

  deleteAll: (conversationId: string) =>
    api.delete(`/context?conversationId=${encodeURIComponent(conversationId)}`),

  embedAll: (conversationId: string) =>
    api.post<{ embedded: number; total: number }>('/context/embed-all', { conversationId }),
};
