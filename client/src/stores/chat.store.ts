import { create } from 'zustand';
import type { Conversation, Message } from '@rpgspeak/shared';
import { streamGenerate, type AffinityUpdate } from '../api/client.ts';

interface StreamingState {
  isStreaming: boolean;
  streamingContent: string;
  streamingMessageId: string | null;
}

interface ChatState extends StreamingState {
  activeConversationId: string | null;
  activeConversation: Conversation | null;
  messages: Message[];
  activeBranchId: string;

  // Provider/model override for this session
  selectedProviderId: string | null;
  selectedModelId: string | null;
  setProviderModel: (providerId: string | null, modelId: string | null) => void;

  // Narrator mode
  narratorMode: boolean;
  setNarratorMode: (v: boolean) => void;

  setActiveConversation: (conv: Conversation | null) => void;
  updateCharacterAffinities: (updates: AffinityUpdate[]) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  removeMessage: (id: string) => void;
  setBranch: (branchId: string) => void;

  sendMessage: (params: {
    message: string;
    characterId?: string;
    overrides?: { temperature?: number; maxTokens?: number; model?: string; providerId?: string };
    /** Override narrator mode for this specific message (e.g. "Continúa la historia" always forces narrator) */
    forceNarratorMode?: boolean;
  }) => Promise<void>;
  stopStreaming: (() => void) | null;
  abort: () => void;
}

function makeErrorMessage(convId: string, text: string): Message {
  return {
    id: `error-${Date.now()}`,
    conversationId: convId,
    parentId: null,
    branchId: 'main',
    role: 'assistant',
    content: text,
    characterId: null,
    tokens: 0,
    isActive: true,
    metadata: { isError: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export const useChatStore = create<ChatState>((set, get) => ({
  activeConversationId: null,
  activeConversation: null,
  messages: [],
  activeBranchId: 'main',
  isStreaming: false,
  streamingContent: '',
  streamingMessageId: null,
  stopStreaming: null,
  selectedProviderId: null,
  selectedModelId: null,
  narratorMode: false,

  setProviderModel: (providerId, modelId) =>
    set({ selectedProviderId: providerId, selectedModelId: modelId }),

  setNarratorMode: (v) => set({ narratorMode: v }),

  setActiveConversation: (conv) =>
    set((state) => {
      // Only reset messages and branch when switching to a DIFFERENT conversation.
      // When the same conversation is updated (e.g. adding characters, renaming),
      // we preserve the current messages so the chat doesn't go blank.
      const isSameConv = conv?.id != null && conv.id === state.activeConversationId;
      return {
        activeConversation: conv,
        activeConversationId: conv?.id ?? null,
        messages: isSameConv ? state.messages : [],
        activeBranchId: isSameConv ? state.activeBranchId : 'main',
        // Always start in narrator mode when entering a conversation.
        // The user can switch to a specific character manually.
        narratorMode: isSameConv ? state.narratorMode : true,
      };
    }),

  updateCharacterAffinities: (updates) =>
    set((s) => {
      if (!s.activeConversation || updates.length === 0) return s;
      const updatedChars = s.activeConversation.characters.map((link) => {
        const u = updates.find((x) => x.characterId === link.characterId);
        return u ? { ...link, affinity: u.newAffinity } : link;
      });
      return { activeConversation: { ...s.activeConversation, characters: updatedChars } };
    }),

  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  updateMessage: (id, updates) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)) })),
  removeMessage: (id) =>
    set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
  setBranch: (branchId) => set({ activeBranchId: branchId }),

  sendMessage: async ({ message, characterId, overrides, forceNarratorMode }) => {
    const { activeConversationId, activeBranchId, addMessage, selectedProviderId, selectedModelId, narratorMode: storeNarratorMode } = get();
    // forceNarratorMode allows individual calls (e.g. "Continúa la historia") to
    // always use narrator mode regardless of what the selector currently shows.
    const narratorMode = forceNarratorMode ?? storeNarratorMode;
    if (!activeConversationId || get().isStreaming) return;

    const mergedOverrides = {
      ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
      ...(selectedModelId    ? { model: selectedModelId }         : {}),
      ...overrides,
    };

    // Optimistic user message
    const tempId = `temp-${Date.now()}`;
    addMessage({
      id: tempId,
      conversationId: activeConversationId,
      parentId: null,
      branchId: activeBranchId,
      role: 'user',
      content: message,
      characterId: null,
      tokens: 0,
      isActive: true,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Streaming placeholder
    const placeholderId = `streaming-${Date.now()}`;
    addMessage({
      id: placeholderId,
      conversationId: activeConversationId,
      parentId: null,
      branchId: activeBranchId,
      role: 'assistant',
      content: '',
      characterId: characterId ?? null,
      tokens: 0,
      isActive: true,
      metadata: { isStreaming: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    set({ isStreaming: true, streamingContent: '', streamingMessageId: placeholderId });

    const abort = await streamGenerate(
      {
        conversationId: activeConversationId,
        message,
        characterId: narratorMode ? undefined : characterId,
        branchId: activeBranchId,
        narratorMode,
        overrides: Object.keys(mergedOverrides).length > 0 ? mergedOverrides : undefined,
      },
      {
        onToken: (token) => {
          set((s) => {
            const newContent = s.streamingContent + token;
            return {
              streamingContent: newContent,
              messages: s.messages.map((m) =>
                m.id === placeholderId ? { ...m, content: newContent } : m
              ),
            };
          });
        },
        onDone: ({ messageId, tokens, tokenBreakdown, promptMessages, affinityUpdates, fastLlmDebug, narrator, characterId, content }) => {
          set((s) => ({
            isStreaming: false,
            streamingContent: '',
            streamingMessageId: null,
            stopStreaming: null,
            messages: s.messages.map((m) =>
              m.id === placeholderId
                ? {
                    ...m,
                    id: messageId,
                    tokens,
                    // Use the server-persisted content (affinity tags stripped, trimmed)
                    // so client-side markdown/regex matches the same text as DB-loaded messages.
                    content: content !== undefined ? content : m.content,
                    // Sync characterId from the persisted message (null for narrator)
                    characterId: characterId !== undefined ? characterId : m.characterId,
                    metadata: {
                      isStreaming: false,
                      // narrator flag — drives styling in MessageItem
                      ...(narrator ? { narrator: true } : {}),
                      ...(tokenBreakdown ? {
                        promptTokens: tokenBreakdown.prompt,
                        completionTokens: tokenBreakdown.completion,
                        cachedTokens: tokenBreakdown.cached,
                      } : {}),
                      ...(promptMessages?.length ? { promptMessages } : {}),
                      ...(fastLlmDebug ? { fastLlmDebug } : {}),
                    },
                  }
                : m
            ),
          }));
          if (affinityUpdates?.length) get().updateCharacterAffinities(affinityUpdates);
        },
        onError: (err) => {
          // Show error as assistant bubble — no silent failure
          set((s) => ({
            isStreaming: false,
            streamingContent: '',
            streamingMessageId: null,
            stopStreaming: null,
            messages: [
              ...s.messages.filter((m) => m.id !== placeholderId && m.id !== tempId),
              makeErrorMessage(activeConversationId!, `⚠️ ${err.message}`),
            ],
          }));
        },
      }
    );

    set({ stopStreaming: abort });
  },

  abort: () => {
    const { stopStreaming, streamingMessageId } = get();
    if (stopStreaming) {
      stopStreaming();
      set((s) => ({
        isStreaming: false,
        streamingContent: '',
        streamingMessageId: null,
        stopStreaming: null,
        // Mark the streaming placeholder as finalized so it renders normally
        // (removes the blinking cursor and streaming indicator)
        messages: s.messages.map((m) =>
          m.id === streamingMessageId
            ? { ...m, metadata: { ...(m.metadata ?? {}), isStreaming: false } }
            : m
        ),
      }));
    }
  },
}));
