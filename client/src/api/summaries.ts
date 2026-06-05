import { api } from './client.ts';
import type { ConversationSummary } from '@rpgspeak/shared';

export const summariesApi = {
  /** Lista todos los resúmenes de una conversación (orden desc por fecha) */
  list: (conversationId: string) =>
    api.get<ConversationSummary[]>(`/summaries?conversationId=${encodeURIComponent(conversationId)}`),

  /** Genera un nuevo resumen para el rango de mensajes indicado */
  generate: (data: { conversationId: string; messageIndexFrom: number; messageIndexTo: number }) =>
    api.post<ConversationSummary>('/summaries/generate', data),

  /** Elimina un resumen por su id */
  delete: (id: string) => api.delete(`/summaries/${id}`),
};
