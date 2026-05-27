import { api } from './client.ts';

export const generateApi = {
  sceneImage: (
    conversationId: string,
    messageId: string,
    workflowName?: string,
    customPrompt?: string,
    useFaceReference?: boolean,
    referenceCharId?: string,
  ) =>
    api.post<{ imageUrl: string; sceneDescription: string }>('/generate/scene-image', {
      conversationId,
      messageId,
      workflowName,
      customPrompt,
      useFaceReference,
      referenceCharId,
    }),

  deleteSceneImage: (conversationId: string, messageId: string) =>
    api.deleteWithBody<{ success: true }>('/generate/scene-image', { conversationId, messageId }),

  /** Returns the raw prompt that would be sent to the LLM (without calling it). */
  buildScenePrompt: (
    conversationId: string,
    messageId: string,
    selectedCharacterIds?: string[],
    includeUser?: boolean,
    messageCount?: number,
  ) =>
    api.post<{ scenePrompt: string }>('/generate/build-scene-prompt', {
      conversationId,
      messageId,
      selectedCharacterIds,
      includeUser,
      messageCount,
    }),

  /** Calls the default LLM with the given prompt and returns the text result. */
  runLlmPrompt: (prompt: string) =>
    api.post<{ result: string }>('/generate/run-llm-prompt', { prompt }),

  /** Re-runs the fast-LLM analysis for an existing assistant message (retry after timeout). */
  analyzeMessage: (messageId: string) =>
    api.post<{ rawResponse: string; rawPrompt: string; affinityUpdates: { characterId: string; newAffinity: number }[] }>(
      '/generate/analyze',
      { messageId },
    ),
};
