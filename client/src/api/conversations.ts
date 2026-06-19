import { api } from './client.ts';
import type { Conversation, Message, CreateConversationDto, UpdateConversationDto, CreateMessageDto, PartyState } from '@rpgspeak/shared';

// Extended update type that includes group management fields the server accepts
type UpdateConversationExtended = UpdateConversationDto & {
  characterIds?: string[];
  storyIds?: string[];
  summary?: string | null;
};

export const conversationsApi = {
  list: (filters: { archived?: boolean; search?: string; characterId?: string; storyId?: string; filterUserId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.archived)      params.set('archived', 'true');
    if (filters.search)        params.set('search', filters.search);
    if (filters.characterId)   params.set('characterId', filters.characterId);
    if (filters.storyId)       params.set('storyId', filters.storyId);
    if (filters.filterUserId)  params.set('filterUserId', filters.filterUserId);
    const qs = params.toString();
    return api.get<Conversation[]>(`/conversations${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => api.get<Conversation>(`/conversations/${id}`),
  create: (data: CreateConversationDto) => api.post<Conversation>('/conversations', data),
  update: (id: string, data: UpdateConversationExtended) =>
    api.patch<Conversation>(`/conversations/${id}`, data),
  delete: (id: string) => api.delete(`/conversations/${id}`),
  summarize: (id: string) => api.post<Conversation>(`/conversations/${id}/summarize`, {}),
  stats: (filterUserId?: string) => api.get<{
    global: { totalTokens: number; totalMessages: number; totalConversations: number; cachedTokens: number };
    conversations: Array<{ id: string; title: string; tokens: number; messages: number; cachedTokens: number; updatedAt: string; isArchived: boolean; userName: string | null }>;
  }>(`/conversations/stats${filterUserId ? `?filterUserId=${encodeURIComponent(filterUserId)}` : ''}`),
  updateCharacterAffinity: (convId: string, charId: string, affinity: number) =>
    api.patch<{ affinity: number }>(`/conversations/${convId}/characters/${charId}/affinity`, { affinity }),
  updateLocation: (convId: string, location: string | null) =>
    api.patch<{ location: string | null }>(`/conversations/${convId}/location`, { location }),
  updatePartyState: (convId: string, partyState: PartyState) =>
    api.patch<Conversation>(`/conversations/${convId}/party-state`, partyState),
};

export const messagesApi = {
  list: (conversationId: string, branchId?: string) =>
    api.get<Message[]>(`/messages?conversationId=${conversationId}${branchId ? `&branchId=${branchId}` : ''}`),
  get: (id: string) => api.get<Message>(`/messages/${id}`),
  create: (data: CreateMessageDto & { conversationId: string; metadata?: Record<string, unknown> }) =>
    api.post<Message>('/messages', data),
  update: (id: string, content: string) =>
    api.patch<Message>(`/messages/${id}`, { content }),
  delete: (id: string) => api.delete(`/messages/${id}`),
  branch: (id: string) => api.post<{ branchId: string }>(`/messages/${id}/branch`, {}),
};
