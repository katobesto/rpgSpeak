import { api } from './client.ts';
import type { Conversation, Message, CreateConversationDto, UpdateConversationDto, CreateMessageDto } from '@rpgspeak/shared';

// Extended update type that includes group management fields the server accepts
type UpdateConversationExtended = UpdateConversationDto & {
  characterIds?: string[];
  storyIds?: string[];
  summary?: string | null;
};

export const conversationsApi = {
  list: (archived?: boolean) =>
    api.get<Conversation[]>(`/conversations${archived ? '?archived=true' : ''}`),
  get: (id: string) => api.get<Conversation>(`/conversations/${id}`),
  create: (data: CreateConversationDto) => api.post<Conversation>('/conversations', data),
  update: (id: string, data: UpdateConversationExtended) =>
    api.patch<Conversation>(`/conversations/${id}`, data),
  delete: (id: string) => api.delete(`/conversations/${id}`),
  summarize: (id: string) => api.post<Conversation>(`/conversations/${id}/summarize`, {}),
  stats: () => api.get<{
    global: { totalTokens: number; totalMessages: number; totalConversations: number; cachedTokens: number };
    conversations: Array<{ id: string; title: string; tokens: number; messages: number; cachedTokens: number; updatedAt: string; isArchived: boolean }>;
  }>('/conversations/stats'),
  updateCharacterAffinity: (convId: string, charId: string, affinity: number) =>
    api.patch<{ affinity: number }>(`/conversations/${convId}/characters/${charId}/affinity`, { affinity }),
};

export const messagesApi = {
  list: (conversationId: string, branchId?: string) =>
    api.get<Message[]>(`/messages?conversationId=${conversationId}${branchId ? `&branchId=${branchId}` : ''}`),
  create: (data: CreateMessageDto & { conversationId: string; metadata?: Record<string, unknown> }) =>
    api.post<Message>('/messages', data),
  update: (id: string, content: string) =>
    api.patch<Message>(`/messages/${id}`, { content }),
  delete: (id: string) => api.delete(`/messages/${id}`),
  branch: (id: string) => api.post<{ branchId: string }>(`/messages/${id}/branch`, {}),
};
