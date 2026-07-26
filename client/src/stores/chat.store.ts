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

/** Una tirada [TIRADA:...] ya resuelta por el servidor pero aún no revelada al
 *  jugador — esperando a que el modal de dados juegue su animación. Hasta que
 *  no se resuelve (DiceRollModal → resolveDiceRoll), el mensaje que la pidió no
 *  lleva diceRoll en su metadata (el badge no se muestra) y la narración no
 *  continúa. */
interface PendingDiceRoll {
  messageId: string;
  diceRoll: DiceRollResult;
  characterId: string | null | undefined;
  narrator: boolean;
  /** Tirada de prueba disparada a mano (botón junto a "Continúa"), sin
   *  mensaje real detrás — al resolverse no toca la conversación ni envía
   *  nada a la IA, solo cierra el modal. Sirve para revisar la animación con
   *  calma sin gastar una tirada real. */
  preview?: boolean;
  /** true = la resolvió el árbitro dedicado ANTES de generar (ver
   *  onDicePending): el narrador ya incluyó el desenlace completo en esta
   *  misma respuesta, así que al cerrar el modal solo hay que REVELARLA, no
   *  pedirle a la IA que continúe (no hay nada que continuar). false/undefined
   *  = vía legado: el propio modelo pidió la tirada a media narración y SÍ
   *  hace falta la llamada de seguimiento para narrar el desenlace. */
  preResolved?: boolean;
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

  /** Tirada pendiente de revelar — ver PendingDiceRoll. Null cuando no hay
   *  ningún dado esperando a que el jugador pulse "Tirar" en el modal. */
  pendingDiceRoll: PendingDiceRoll | null;
  /** Llamado por DiceRollModal cuando termina su animación: revela el
   *  resultado en el mensaje (badge) y envía la nota OOC que hace que la IA
   *  continúe narrando el desenlace. */
  resolveDiceRoll: () => void;
  /** Abre el modal con una tirada de prueba (sin efecto en la conversación) —
   *  botón junto a "Continúa", para revisar la animación a demanda. */
  previewDiceRoll: () => void;

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
  pendingDiceRoll: null,

  resolveDiceRoll: () => {
    const pending = get().pendingDiceRoll;
    if (!pending) return;
    // Tirada de prueba: no hay mensaje real detrás, así que no toca la
    // conversación ni le pide nada a la IA — solo cierra el modal.
    if (pending.preview) {
      set({ pendingDiceRoll: null });
      return;
    }
    // El contenido NUNCA se retuvo — se generó y aplicó con total normalidad
    // en segundo plano (onToken/onDone, sin gating). Lo único que dependía
    // del modal era la VISIBILIDAD (ver `diceGateVisual` en MessageItem), así
    // que resolver el modal es tan simple como: apagar esa marca y anotar el
    // resultado para el badge. Si la generación aún no ha terminado (el
    // jugador tiró y pulsó "Continuar" muy rápido), esto simplemente deja de
    // ocultarlo — se seguirá viendo completarse en vivo, como un mensaje
    // normal, en vez de quedarse atascado a medias.
    set((s) => ({
      pendingDiceRoll: null,
      messages: s.messages.map((m) =>
        m.metadata?.diceGateVisual || m.id === pending.messageId
          ? { ...m, metadata: { ...m.metadata, diceRoll: pending.diceRoll, diceGateVisual: false } }
          : m
      ),
    }));
    // Con el árbitro dedicado (preResolved), el narrador YA incluyó el
    // desenlace completo en esta misma respuesta — no hay nada que continuar.
    // Solo la vía legado (el modelo pide la tirada él mismo y detiene la
    // narración a media acción) necesita esta llamada de seguimiento.
    if (pending.preResolved) return;
    void get().sendMessage({
      message: formatDiceOutcome(pending.diceRoll),
      characterId: pending.characterId ?? undefined,
      forceNarratorMode: pending.narrator,
    });
  },

  previewDiceRoll: () => {
    // Datos de muestra realistas — solo para ver la animación con calma, sin
    // gastar una tirada real ni depender de que la IA la pida.
    const modifier = 2;
    const cd = 15;
    const natural = 1 + Math.floor(Math.random() * 20);
    const total = natural + modifier;
    const critical = natural === 20 ? 'success' : natural === 1 ? 'failure' : null;
    const success = critical !== null ? critical === 'success' : total >= cd;
    set({
      pendingDiceRoll: {
        messageId: '__preview__',
        diceRoll: { who: 'Javier', attribute: 'Destreza', cd, description: 'Prueba de la tirada de dados', natural, modifier, total, success, critical },
        characterId: undefined,
        narrator: true,
        preview: true,
      },
    });
  },

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
    // El guard de pendingDiceRoll es cinturón-y-tirantes: el modal ya bloquea
    // toda la pantalla mientras espera a que el jugador pulse "Tirar", así que
    // en la práctica ningún botón debería poder disparar sendMessage antes de
    // eso. resolveDiceRoll limpia pendingDiceRoll ANTES de llamar aquí, así
    // que su propio envío nunca queda bloqueado por este check.
    if (!activeConversationId || get().isStreaming || get().pendingDiceRoll) return;

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
        // El árbitro dedicado ya resolvió la tirada, ANTES de que llegue ni un
        // solo token — abre el modal ya. El contenido sigue fluyendo con
        // total normalidad por onToken/onDone (nada se retiene ni se
        // bufferea): lo único que cambia es que MessageItem oculta este
        // mensaje en concreto mientras `diceGateVisual` esté activo, y deja
        // de hacerlo en cuanto resolveDiceRoll lo apaga. Si el jugador cierra
        // el modal antes de que termine de generarse, simplemente se ve
        // completarse en vivo — nunca se queda a medias.
        onDicePending: (diceRoll) => {
          set((s) => ({
            pendingDiceRoll: {
              messageId: placeholderId,
              diceRoll,
              characterId: narratorMode ? null : (characterId ?? null),
              narrator: narratorMode,
              preResolved: true,
            },
            messages: s.messages.map((m) =>
              m.id === placeholderId ? { ...m, metadata: { ...m.metadata, diceGateVisual: true } } : m
            ),
          }));
        },
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
          // ¿Este mensaje ya pasó por el árbitro dedicado (onDicePending)?
          // La clave existe (true O false) en cuanto se marcó, sea cual sea
          // su estado actual — a diferencia de comprobar `pendingDiceRoll`
          // (que ya puede estar en null si el jugador resolvió el modal
          // ANTES de que la generación terminase). Sin esto, resolver pronto
          // hacía que este onDone, al llegar después, disparara un SEGUNDO
          // modal por la vía legado — con su propio envío de seguimiento,
          // duplicando la respuesta.
          const alreadyGated = get().messages.some(
            (m) => m.id === placeholderId && m.metadata?.diceGateVisual !== undefined
          );
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
                      // Conserva diceGateVisual si el árbitro lo marcó arriba
                      // — la visibilidad la apaga solo resolveDiceRoll.
                      ...m.metadata,
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
          // Vía legado (sin árbitro dedicado): el propio modelo pidió la
          // tirada a media narración. El mensaje ya es visible (se detuvo
          // ANTES del desenlace, nada que ocultar); el modal solo añade el
          // badge y dispara la llamada de seguimiento al resolverse.
          if (diceRoll && !alreadyGated) {
            set({ pendingDiceRoll: { messageId, diceRoll, characterId, narrator: Boolean(narrator), preResolved: false } });
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
          // Show error as assistant bubble — no silent failure. Si el error
          // llega con el modal de esta tirada ya abierto, hay que cerrarlo
          // aquí — si no, queda huérfano (el mensaje que lo sostenía ya no
          // existirá).
          set((s) => ({
            isStreaming: false,
            streamingContent: '',
            streamingMessageId: null,
            stopStreaming: null,
            pendingDiceRoll: s.pendingDiceRoll?.messageId === placeholderId ? null : s.pendingDiceRoll,
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
        // Ver el comentario extenso en sendMessage: el contenido fluye con
        // normalidad, solo se marca el mensaje para que MessageItem lo oculte
        // hasta resolveDiceRoll.
        onDicePending: (diceRoll) => {
          set((s) => ({
            pendingDiceRoll: {
              messageId: placeholderId,
              diceRoll,
              characterId: narratorMode ? null : (charId ?? null),
              narrator: narratorMode,
              preResolved: true,
            },
            messages: s.messages.map((m) =>
              m.id === placeholderId ? { ...m, metadata: { ...m.metadata, diceGateVisual: true } } : m
            ),
          }));
        },
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
          // Ver el comentario extenso en sendMessage: comprobar la marca del
          // propio mensaje, no `pendingDiceRoll` (que ya puede ser null si el
          // jugador resolvió el modal antes de que esto llegara).
          const alreadyGated = get().messages.some(
            (m) => m.id === placeholderId && m.metadata?.diceGateVisual !== undefined
          );
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
                      ...m.metadata,
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
          if (diceRoll && !alreadyGated) {
            set({ pendingDiceRoll: { messageId, diceRoll, characterId: doneCharId, narrator: Boolean(narrator), preResolved: false } });
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
            pendingDiceRoll: s.pendingDiceRoll?.messageId === placeholderId ? null : s.pendingDiceRoll,
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
