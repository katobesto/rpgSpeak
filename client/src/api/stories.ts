import { api } from './client.ts';
import type {
  Story, CreateStoryDto, UpdateStoryDto, StoryEvent, StoryLocation,
  StoryAssistantBriefing, StoryAssistantResult,
} from '@rpgspeak/shared';

export const storiesApi = {
  list: (filters: { search?: string; text?: string; characterId?: string; filterUserId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.search)       params.set('search', filters.search);
    if (filters.text)         params.set('text', filters.text);
    if (filters.characterId)  params.set('characterId', filters.characterId);
    if (filters.filterUserId) params.set('filterUserId', filters.filterUserId);
    const qs = params.toString();
    return api.get<Story[]>(`/stories${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => api.get<Story>(`/stories/${id}`),
  create: (data: CreateStoryDto) => api.post<Story>('/stories', data),
  update: (id: string, data: UpdateStoryDto) => api.patch<Story>(`/stories/${id}`, data),
  delete: (id: string) => api.delete(`/stories/${id}`),
  generateEvents: (storyId: string, numEvents = 5) =>
    api.post<{ events: StoryEvent[] }>('/stories/generate-events', { storyId, numEvents }),
  generateLocations: (storyId: string, numLocations = 5) =>
    api.post<{ locations: StoryLocation[] }>('/stories/generate-locations', { storyId, numLocations }),
  runAssistant: (briefing: StoryAssistantBriefing) =>
    api.post<StoryAssistantResult>('/stories/assistant', briefing),
};
