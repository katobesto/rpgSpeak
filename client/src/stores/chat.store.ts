import { create } from 'zustand';
import type { Conversation, Message, MessageMetadata, DeathLoopState, DiceRollResult } from '@rpgspeak/shared';
import { streamGenerate, type AffinityUpdate } from '../api/client.ts';
import { messagesApi } from '../api/conversations.ts';

/** Mensaje oculto que dispara la narración de apertura al comenzar una historia.
 *  Se filtra de la vista por su contenido (así también queda oculto tras recargar,
 *  ya que el servidor lo persiste como cualquier mensaje de usuario). */
export const STORY_KICKOFF_MSG =
  'Narrador, comienza la historia: presenta la escena de apertura —el momento y el lugar donde arranca— y sitúame en ella. No esperes mi intervención.';

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

  // Id de la conversación que debe auto-iniciar su narración de apertura al
  // abrirse vacía (fijado al "Comenzar historia"). Se consume una sola vez.
  pendingAutoStart: string | null;
  setPendingAutoStart: (conversationId: string | null) => void;

  setActiveConversation: (conv: Conversation | null) => void;
  updateCharacterAffinities: (updates: AffinityUpdate[]) => void;
  updateCurrentLocation: (location: string | null) => void;
  setDeathLoop: (deathLoop: DeathLoopState | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  removeMessage: (id: string) => void;
  setBranch: (branchId: string) => void;

  /** Content of the most recently attempted user message — kept so regenerate can
   *  re-send it when the original was removed from the store by an error handler. */
  lastAttemptedMessage: string | null;

  sendMessage: (params: {
    message: string;
    characterId?: string;
    overrides?: { temperature?: number; maxTokens?: number; model?: string; providerId?: string };
    /** Override narrator mode for this specific message (e.g. "Continúa la historia" always forces narrator) */
    forceNarratorMode?: boolean;
  }) => Promise<void>;

  /** Re-generate the response for a given assistant message.
   *  Deletes the assistant message (and its preceding user message) from the
   *  server, then re-streams with the same user content. Also works for
   *  ephemeral error messages (id starts with "error-"). */
  regenerate: (assistantMessageId: string, characterId?: string | null) => Promise<void>;

  /** Rebobinar: elimina del servidor y del store todos los mensajes posteriores
   *  a `messageId` (el propio mensaje ancla se conserva). */
  rewind: (messageId: string) => Promise<void>;

  stopStreaming: (() => void) | null;
  abort: () => void;
}

/** Quita `enrichStep` de la metadata de un mensaje, sin dejar una variable
 *  descartada por el `...rest` — solo se usa al terminar el enriquecimiento
 *  de fondo, para ocultar el indicador transitorio. */
function withoutEnrichStep(metadata: MessageMetadata): MessageMetadata {
  const rest = { ...metadata };
  delete rest.enrichStep;
  return rest;
}

/** Nota OOC con el desenlace de una tirada [TIRADA:...] — el mismo canal que ya
 *  usa el jugador para dirigir la escena sin que los personajes "oigan" nada
 *  (ver ooc.ts en el servidor). Aquí lo reutilizamos en sentido inverso: el
 *  servidor informa a la IA de un hecho consumado (el número), no del jugador. */
function formatDiceOutcome(diceRoll: DiceRollResult): string {
  const resultLabel =
    diceRoll.critical === 'success' ? '¡ÉXITO CRÍTICO!' :
    diceRoll.critical === 'failure' ? '¡FALLO CRÍTICO!' :
    diceRoll.success ? 'ÉXITO' : 'FALLO';
  return (
    `(Resultado de la tirada — ${diceRoll.who}, ${diceRoll.attribute} (CD ${diceRoll.cd}): ` +
    `${diceRoll.natural} natural + ${diceRoll.modifier} = ${diceRoll.total} → ${resultLabel}. ` +
    `Continúa narrando el desenlace a partir de este resultado, sin repetir la tirada.)`
  );
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
  pendingAutoStart: null,
  lastAttemptedMessage: null,

  setPendingAutoStart: (conversationId) => set({ pendingAutoStart: conversationId }),

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

  // Estado del bucle de muerte llegado por SSE: se refleja en el metadata de la
  // conversación activa, de donde lo lee la UI (banner / chip del bucle).
  setDeathLoop: (deathLoop) =>
    set((s) => {
      if (!s.activeConversation) return s;
      return {
        activeConversation: {
          ...s.activeConversation,
          metadata: { ...s.activeConversation.metadata, deathLoop },
        },
      };
    }),

  updateCurrentLocation: (location) =>
    set((s) => {
      if (!s.activeConversation) return s;
      return { activeConversation: { ...s.activeConversation, currentLocation: location } };
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

    set({ isStreaming: true, streamingContent: '', streamingMessageId: placeholderId, lastAttemptedMessage: message });

    // El mensaje pasa de `placeholderId` a su id real dentro de onDone, pero los
    // eventos de progreso del enriquecimiento de fondo (onEnrichStep/onEnrichDone)
    // llegan DESPUÉS por la misma conexión — necesitan saber a qué mensaje final
    // atarse. Esta variable la actualiza onDone y la leen los closures de abajo.
    let resolvedMessageId = placeholderId;

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
        onThinkToken: (token) => {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === placeholderId
                ? {
                    ...m,
                    metadata: {
                      ...m.metadata,
                      isThinking: true,
                      thinkContent: ((m.metadata?.thinkContent as string) || '') + token,
                    },
                  }
                : m
            ),
          }));
        },
        onToken: (token) => {
          set((s) => {
            const newContent = s.streamingContent + token;
            return {
              streamingContent: newContent,
              messages: s.messages.map((m) =>
                m.id === placeholderId
                  ? {
                      ...m,
                      content: newContent,
                      metadata: { ...m.metadata, isThinking: false },
                    }
                  : m
              ),
            };
          });
        },
        onDone: ({ messageId, userMessageId, tokens, tokenBreakdown, promptMessages, affinityUpdates, fastLlmDebug, narrator, characterId, content, locationUpdate, thinkContent, deathLoop, diceRoll }) => {
          resolvedMessageId = messageId;
          set((s) => ({
            isStreaming: false,
            streamingContent: '',
            streamingMessageId: null,
            stopStreaming: null,
            messages: s.messages.map((m) =>
              m.id === tempId ? { ...m, id: userMessageId } : m
            ).map((m) =>
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
                      isThinking: false,
                      // narrator flag — drives styling in MessageItem
                      ...(narrator ? { narrator: true } : {}),
                      ...(tokenBreakdown ? {
                        promptTokens: tokenBreakdown.prompt,
                        completionTokens: tokenBreakdown.completion,
                        cachedTokens: tokenBreakdown.cached,
                      } : {}),
                      ...(promptMessages?.length ? { promptMessages } : {}),
                      ...(fastLlmDebug ? { fastLlmDebug } : {}),
                      ...(affinityUpdates?.length ? { affinityUpdates } : {}),
                      ...(thinkContent ? { thinkContent } : {}),
                      ...(diceRoll ? { diceRoll } : {}),
                    },
                  }
                : m
            ),
          }));
          if (affinityUpdates?.length) get().updateCharacterAffinities(affinityUpdates);
          if (locationUpdate !== undefined) get().updateCurrentLocation(locationUpdate);
          if (deathLoop !== undefined) get().setDeathLoop(deathLoop);
          // La tirada pausa la narración a propósito (ver DICE_ROLL_INSTRUCTION);
          // el servidor ya tiene el número, así que disparamos el desenlace solo
          // — el jugador no necesita escribir nada para que la escena continúe.
          if (diceRoll) {
            void get().sendMessage({
              message: formatDiceOutcome(diceRoll),
              characterId: characterId ?? undefined,
              forceNarratorMode: Boolean(narrator),
            });
          }
        },
        // Ráfaga de llamadas al LLM en segundo plano (director de escena,
        // resúmenes...) tras un mensaje que YA está terminado y visible. Se
        // guarda en la metadata del propio mensaje para que MessageItem la
        // muestre como un indicador transitorio bajo la respuesta.
        onEnrichStep: (step) => {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === resolvedMessageId ? { ...m, metadata: { ...m.metadata, enrichStep: step } } : m
            ),
          }));
        },
        onEnrichDone: (info) => {
          set((s) => ({
            messages: s.messages.map((m) => {
              if (m.id !== resolvedMessageId) return m;
              const metadata = withoutEnrichStep(m.metadata);
              // Coste real de las llamadas de fondo del turno — el servidor ya
              // lo persistió en el mensaje; esto lo refleja sin recargar.
              if (info?.bgTokens) metadata.bgTokens = info.bgTokens;
              return { ...m, metadata };
            }),
          }));
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

  regenerate: async (assistantMessageId, characterIdArg) => {
    const {
      activeConversationId, activeBranchId, messages,
      selectedProviderId, selectedModelId, narratorMode: storeNarratorMode,
      isStreaming, lastAttemptedMessage, addMessage,
    } = get();

    if (!activeConversationId || isStreaming) return;

    const isEphemeral =
      assistantMessageId.startsWith('error-') || assistantMessageId.startsWith('streaming-');

    let userContent: string | null = null;
    let charId: string | undefined = characterIdArg ?? undefined;
    // Regenerar debe reproducir el MODO del mensaje original, no el estado
    // actual del selector: si se regeneraba una narración con el selector en un
    // personaje (o viceversa), la respuesta cambiaba de naturaleza. Para
    // mensajes efímeros (error/streaming) no hay metadata → selector actual.
    let messageNarratorMode: boolean | null = null;
    const idsToRemove = new Set<string>([assistantMessageId]);

    if (isEphemeral) {
      // Error bubble: no DB record — just use the last attempted message content
      userContent = lastAttemptedMessage;
    } else {
      // Real assistant message: find and delete the preceding user message too
      const msgIndex = messages.findIndex((m) => m.id === assistantMessageId);
      if (msgIndex !== -1) {
        if (!charId) charId = messages[msgIndex].characterId ?? undefined;
        messageNarratorMode = Boolean(messages[msgIndex].metadata?.narrator);
        for (let i = msgIndex - 1; i >= 0; i--) {
          if (messages[i].role === 'user') {
            userContent = messages[i].content;
            const uid = messages[i].id;
            idsToRemove.add(uid);
            if (!uid.startsWith('temp-')) {
              try { await messagesApi.delete(uid); } catch { /* ignore */ }
            }
            break;
          }
        }
      }
      try { await messagesApi.delete(assistantMessageId); } catch { /* ignore */ }
    }

    if (!userContent) return;

    // Remove the old messages from the store
    set((s) => ({ messages: s.messages.filter((m) => !idsToRemove.has(m.id)) }));

    // Optimistic user message (mirrors sendMessage behaviour)
    const tempId = `temp-${Date.now()}`;
    addMessage({
      id: tempId,
      conversationId: activeConversationId,
      parentId: null,
      branchId: activeBranchId,
      role: 'user',
      content: userContent,
      characterId: null,
      tokens: 0,
      isActive: true,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const placeholderId = `streaming-${Date.now()}`;
    addMessage({
      id: placeholderId,
      conversationId: activeConversationId,
      parentId: null,
      branchId: activeBranchId,
      role: 'assistant',
      content: '',
      characterId: charId ?? null,
      tokens: 0,
      isActive: true,
      metadata: { isStreaming: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const narratorMode = messageNarratorMode ?? storeNarratorMode;
    const mergedOverrides = {
      ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
      ...(selectedModelId    ? { model: selectedModelId }         : {}),
    };

    set({ isStreaming: true, streamingContent: '', streamingMessageId: placeholderId, lastAttemptedMessage: userContent });

    // Ver comentario equivalente en sendMessage: onEnrichStep/onEnrichDone
    // llegan después de onDone y necesitan el id YA resuelto del mensaje.
    let resolvedMessageId = placeholderId;

    const abort = await streamGenerate(
      {
        conversationId: activeConversationId,
        message: userContent,
        characterId: narratorMode ? undefined : charId,
        branchId: activeBranchId,
        narratorMode,
        overrides: Object.keys(mergedOverrides).length > 0 ? mergedOverrides : undefined,
      },
      {
        onThinkToken: (token) => {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === placeholderId
                ? { ...m, metadata: { ...m.metadata, isThinking: true, thinkContent: ((m.metadata?.thinkContent as string) || '') + token } }
                : m
            ),
          }));
        },
        onToken: (token) => {
          set((s) => {
            const newContent = s.streamingContent + token;
            return {
              streamingContent: newContent,
              messages: s.messages.map((m) =>
                m.id === placeholderId
                  ? { ...m, content: newContent, metadata: { ...m.metadata, isThinking: false } }
                  : m
              ),
            };
          });
        },
        onDone: ({ messageId, tokens, tokenBreakdown, promptMessages, affinityUpdates, fastLlmDebug, narrator, characterId: doneCharId, content, locationUpdate, thinkContent, deathLoop, diceRoll }) => {
          resolvedMessageId = messageId;
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
                    content: content !== undefined ? content : m.content,
                    characterId: doneCharId !== undefined ? doneCharId : m.characterId,
                    metadata: {
                      isStreaming: false,
                      isThinking: false,
                      ...(narrator ? { narrator: true } : {}),
                      ...(tokenBreakdown ? { promptTokens: tokenBreakdown.prompt, completionTokens: tokenBreakdown.completion, cachedTokens: tokenBreakdown.cached } : {}),
                      ...(promptMessages?.length ? { promptMessages } : {}),
                      ...(fastLlmDebug ? { fastLlmDebug } : {}),
                      ...(affinityUpdates?.length ? { affinityUpdates } : {}),
                      ...(thinkContent ? { thinkContent } : {}),
                      ...(diceRoll ? { diceRoll } : {}),
                    },
                  }
                : m
            ),
          }));
          if (affinityUpdates?.length) get().updateCharacterAffinities(affinityUpdates);
          if (locationUpdate !== undefined) get().updateCurrentLocation(locationUpdate);
          if (deathLoop !== undefined) get().setDeathLoop(deathLoop);
          if (diceRoll) {
            void get().sendMessage({
              message: formatDiceOutcome(diceRoll),
              characterId: doneCharId ?? undefined,
              forceNarratorMode: Boolean(narrator),
            });
          }
        },
        onEnrichStep: (step) => {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === resolvedMessageId ? { ...m, metadata: { ...m.metadata, enrichStep: step } } : m
            ),
          }));
        },
        onEnrichDone: (info) => {
          set((s) => ({
            messages: s.messages.map((m) => {
              if (m.id !== resolvedMessageId) return m;
              const metadata = withoutEnrichStep(m.metadata);
              // Coste real de las llamadas de fondo del turno — el servidor ya
              // lo persistió en el mensaje; esto lo refleja sin recargar.
              if (info?.bgTokens) metadata.bgTokens = info.bgTokens;
              return { ...m, metadata };
            }),
          }));
        },
        onError: (err) => {
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

  rewind: async (messageId) => {
    const { messages, isStreaming } = get();
    if (isStreaming) return;

    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    // No hay nada posterior que borrar.
    if (idx === messages.length - 1) return;

    const idsAfter = messages.slice(idx + 1).map((m) => m.id);

    // Optimista: recorta el store de inmediato. El ancla (idx) se conserva.
    set((s) => ({ messages: s.messages.slice(0, s.messages.findIndex((m) => m.id === messageId) + 1) }));

    try {
      // El ancla puede ser un id temporal/efímero si la conversación no se ha
      // recargado; en ese caso no existe en BD y no hay cola persistida que cortar.
      const isPersisted = !messageId.startsWith('temp-') && !messageId.startsWith('streaming-') && !messageId.startsWith('error-');
      if (isPersisted) {
        await messagesApi.deleteAfter(messageId);
      } else {
        // Ancla no persistida: borra uno a uno los posteriores que sí lo estén.
        for (const id of idsAfter) {
          if (!id.startsWith('temp-') && !id.startsWith('streaming-') && !id.startsWith('error-')) {
            try { await messagesApi.delete(id); } catch { /* ignore */ }
          }
        }
      }
    } catch {
      // Si el borrado en servidor falla, recargamos para resincronizar el store.
      const { activeConversationId, activeBranchId } = get();
      if (activeConversationId) {
        try {
          const fresh = await messagesApi.list(activeConversationId, activeBranchId);
          set({ messages: fresh });
        } catch { /* ignore */ }
      }
    }
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
