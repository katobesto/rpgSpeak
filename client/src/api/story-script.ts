import { api } from './client.ts';
import type { StoryScriptChapter } from '@rpgspeak/shared';

export const storyScriptApi = {
  get:        (storyId: string) =>
    api.get<StoryScriptChapter[]>(`/story-script/${storyId}`),

  generate:   (storyId: string, regenerate = false) =>
    api.post<StoryScriptChapter[]>('/story-script/generate', { storyId, regenerate }),

  copyToConversation: (storyId: string, conversationId: string) =>
    api.post<{ success: boolean }>('/story-script/copy-to-conversation', { storyId, conversationId }),

  delete:     (storyId: string) =>
    api.delete(`/story-script/${storyId}`),
};
