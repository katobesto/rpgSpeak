import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useBackHandler } from '../../hooks/useBackHandler.ts';
import { MessageList, type MessageListHandle } from './MessageList.tsx';
import { MessageInput } from './MessageInput.tsx';
import { GroupPanel } from './GroupPanel.tsx';
import { SummaryModal } from './SummaryModal.tsx';
import { ContextModal } from './ContextModal.tsx';
import { StatsModal } from './StatsModal.tsx';
import { ChatSearchModal } from './ChatSearchModal.tsx';
import { ImageGalleryModal } from './ImageGalleryModal.tsx';
import { BackgroundGeneratorModal } from './BackgroundGeneratorModal.tsx';
import { BattleModal } from './BattleModal.tsx';
import { useChatStore, STORY_KICKOFF_MSG } from '../../stores/chat.store.ts';
import { useAuthStore } from '../../stores/auth.store.ts';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { messagesApi, conversationsApi } from '../../api/conversations.ts';
import { charactersApi } from '../../api/characters.ts';
import { storiesApi } from '../../api/stories.ts';
import { api } from '../../api/client.ts';
import {
  MessageSquarePlus,
  Users,
  MoreHorizontal,
  Pencil,
  Zap,
  BookOpen,
  BarChart2,
  ScrollText,
  Pin,
  X,
  Sword,
  Search,
  Clock,
  MessagesSquare,
  ChevronRight,
  Images,
  SlidersHorizontal,
  UserCircle,
  Filter,
  Map,
  Info,
  Navigation,
  MapPin,
  ImagePlus,
  Skull,
  RotateCcw,
  Download,
  Upload,
} from 'lucide-react';
import { Avatar } from '../ui/Avatar.tsx';
import type { Character, Story, Conversation, User, ConversationBackground, PartyState, DeathLoopState } from '@rpgspeak/shared';

export function ChatWindow() {
  const {
    activeConversation, setMessages, messages, setActiveConversation,
    addMessage, updateCurrentLocation, sendMessage,
    pendingAutoStart, setPendingAutoStart, isStreaming,
  } = useChatStore();
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState('');
  const [locationEditing, setLocationEditing] = useState(false);
  const [locationValue, setLocationValue] = useState('');

  // Panel / modal states
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const [statsModalOpen, setStatsModalOpen] = useState(false);
  const [contextModalOpen, setContextModalOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [anchorModalOpen, setAnchorModalOpen] = useState(false);
  const [locationsModalOpen, setLocationsModalOpen] = useState(false);
  const [backgroundModalOpen, setBackgroundModalOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [battleOpen, setBattleOpen] = useState(false);

  // ── Regreso después de la muerte ─────────────────────────────────────────
  const deathLoop =
    ((activeConversation?.metadata as { deathLoop?: DeathLoopState | null } | undefined)?.deathLoop) ?? null;
  const [deathRewinding, setDeathRewinding] = useState(false);
  const [deathClearing, setDeathClearing]   = useState(false);

  async function handleDeathRewind() {
    const id = activeConversation?.id;
    if (!id || deathRewinding) return;
    setDeathRewinding(true);
    try {
      const { conversation } = await conversationsApi.deathRewind(id);
      setActiveConversation(conversation);
      setMessages(await messagesApi.list(id));
    } catch (err) {
      console.error('[death] Error al rebobinar:', err);
    } finally {
      setDeathRewinding(false);
    }
  }

  async function handleDeathClear() {
    const id = activeConversation?.id;
    if (!id || deathClearing) return;
    if (!window.confirm('¿Dar la muerte por superada y cerrar el bucle? La IA dejará de forzar la repetición de la secuencia fatal.')) return;
    setDeathClearing(true);
    try {
      setActiveConversation(await conversationsApi.clearDeathLoop(id));
    } catch (err) {
      console.error('[death] Error al cerrar el bucle:', err);
    } finally {
      setDeathClearing(false);
    }
  }
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  // Narration prompt queued during onBattleEnd, fired once the modal is confirmed closed
  const [pendingNarration, setPendingNarration] = useState<string | null>(null);

  useEffect(() => {
    if (!battleOpen && pendingNarration) {
      const prompt = pendingNarration;
      setPendingNarration(null);
      sendMessage({ message: prompt, forceNarratorMode: true });
    }
  }, [battleOpen, pendingNarration]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close topmost open modal/panel on mobile swipe-back
  const anyModalOpen = groupPanelOpen || summaryModalOpen || statsModalOpen ||
    contextModalOpen || galleryOpen || anchorModalOpen || locationsModalOpen || searchOpen || battleOpen;
  const closeTopModal = useCallback(() => {
    if (battleOpen)         { setBattleOpen(false);         return; }
    if (searchOpen)         { setSearchOpen(false);         return; }
    if (galleryOpen)        { setGalleryOpen(false);        return; }
    if (anchorModalOpen)    { setAnchorModalOpen(false);    return; }
    if (locationsModalOpen) { setLocationsModalOpen(false); return; }
    if (groupPanelOpen)     { setGroupPanelOpen(false);     return; }
    if (summaryModalOpen)   { setSummaryModalOpen(false);   return; }
    if (statsModalOpen)     { setStatsModalOpen(false);     return; }
    if (contextModalOpen)   { setContextModalOpen(false);   return; }
  }, [battleOpen, searchOpen, galleryOpen, anchorModalOpen, locationsModalOpen,
      groupPanelOpen, summaryModalOpen, statsModalOpen, contextModalOpen]);
  useBackHandler(anyModalOpen, closeTopModal);
  const messageListRef = useRef<MessageListHandle>(null);

  // El mensaje de arranque de historia se oculta de la vista (dispara la
  // narración de apertura pero no debe verse como un turno del jugador).
  const visibleMessages = React.useMemo(
    () => messages.filter((m) => !(m.role === 'user' && m.content === STORY_KICKOFF_MSG)),
    [messages],
  );

  const convId = activeConversation?.id;

  const { data: fetchedMessages } = useQuery({
    queryKey: ['messages', convId],
    queryFn: () => messagesApi.list(convId!),
    enabled: !!convId,
  });

  useEffect(() => {
    if (fetchedMessages) setMessages(fetchedMessages);
  }, [fetchedMessages, setMessages]);

  // Safety net: if the store's message list is empty but the query has data
  // (happens when setActiveConversation cleared messages but the query key
  // didn't change so the effect above never re-fired), force-sync from cache.
  useEffect(() => {
    if (fetchedMessages && messages.length === 0 && fetchedMessages.length > 0) {
      setMessages(fetchedMessages);
    }
  }, [messages.length, fetchedMessages, setMessages]);

  useEffect(() => {
    if (activeConversation) {
      setActiveCharacterId(
        activeConversation.activeCharacterId ?? activeConversation.characters[0]?.characterId ?? null
      );
      setTitleValue(activeConversation.title);
    }
  }, [activeConversation]);

  // ── Auto-inicio de historia ────────────────────────────────────────────────
  // Al "Comenzar historia" se crea la conversación y se marca pendingAutoStart.
  // Cuando su lista de mensajes ha cargado y está VACÍA, se dispara la narración
  // de apertura en modo narrador. Se consume el flag primero para no repetir.
  useEffect(() => {
    if (!activeConversation || !pendingAutoStart) return;
    if (activeConversation.id !== pendingAutoStart) return;
    if (isStreaming) return;
    if (fetchedMessages === undefined) return;           // aún cargando
    if (fetchedMessages.length > 0) { setPendingAutoStart(null); return; } // no es nueva
    setPendingAutoStart(null);
    void sendMessage({ message: STORY_KICKOFF_MSG, forceNarratorMode: true });
  }, [activeConversation, pendingAutoStart, fetchedMessages, isStreaming, setPendingAutoStart, sendMessage]);

  // Close more menu on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Ctrl+F / Cmd+F → open search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && activeConversation) {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeConversation]);

  // Clear highlight after flash animation completes
  useEffect(() => {
    if (!highlightedMessageId) return;
    const id = setTimeout(() => setHighlightedMessageId(null), 2100);
    return () => clearTimeout(id);
  }, [highlightedMessageId]);

  function handleSearchJump(messageIndex: number, messageId: string) {
    setSearchOpen(false);
    setHighlightedMessageId(messageId);
    messageListRef.current?.scrollToMessageIndex(messageIndex);
  }

  const { data: allCharacters = [] } = useQuery({
    queryKey: ['characters'],
    queryFn: () => charactersApi.list(),
  });

  const { data: allStories = [] } = useQuery({
    queryKey: ['stories'],
    queryFn: () => storiesApi.list(),
  });


  const { data: allConversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => conversationsApi.list(),
  });

  const charIds = activeConversation?.characters.map((c) => c.characterId) ?? [];
  const characters: Character[] = charIds.length > 0
    ? allCharacters.filter((c) => charIds.includes(c.id))
    : [];

  const updateTitle = useMutation({
    mutationFn: (title: string) => conversationsApi.update(convId!, { title }),
    onSuccess: (updated) => {
      setActiveConversation(updated);   // same convId → messages preserved by store fix
      qc.invalidateQueries({ queryKey: ['conversations'] });
      setEditingTitle(false);
    },
  });

  const updateActiveChar = useMutation({
    mutationFn: (characterId: string) =>
      conversationsApi.update(convId!, { activeCharacterId: characterId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  });

  const startConversation = useMutation({
    mutationFn: ({ title, characterIds, storyIds }: { title: string; characterIds: string[]; storyIds: string[] }) =>
      conversationsApi.create({ title, characterIds, storyIds }),
    onSuccess: (conv) => {
      setActiveConversation(conv);
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const updateGroup = useMutation({
    mutationFn: ({ characterIds, storyIds }: { characterIds: string[]; storyIds: string[] }) =>
      conversationsApi.update(convId!, { characterIds, storyIds }),
    onSuccess: (updated) => {
      setActiveConversation(updated);
      // Invalidate all related queries so derived data (characters, stories, messages)
      // stays fresh after modifying the group composition.
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['characters'] });
      qc.invalidateQueries({ queryKey: ['stories'] });
      qc.invalidateQueries({ queryKey: ['messages', updated.id] });
    },
  });

  const updateLocationMutation = useMutation({
    mutationFn: (location: string | null) => conversationsApi.updateLocation(convId!, location),
    onSuccess: (_, location) => {
      updateCurrentLocation(location);
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  function saveLocation() {
    const trimmed = locationValue.trim() || null;
    updateLocationMutation.mutate(trimmed);
    setLocationEditing(false);
  }

  function handleCharacterChange(id: string) {
    setActiveCharacterId(id);
    updateActiveChar.mutate(id);
  }

  const [exporting, setExporting] = useState(false);
  async function handleExportChat() {
    if (!activeConversation || exporting) return;
    setExporting(true);
    try {
      const pkg = await conversationsApi.exportChat(activeConversation.id);
      const blob = new Blob([JSON.stringify(pkg)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const safeTitle = (activeConversation.title || 'chat').replace(/[^\w-]+/g, '_').slice(0, 40) || 'chat';
      const date = new Date().toISOString().split('T')[0];
      const a = document.createElement('a');
      a.href = url;
      a.download = `rpgspeak-chat-${safeTitle}-${date}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[export] Error al exportar el chat:', err);
      window.alert('No se pudo exportar el chat.');
    } finally {
      setExporting(false);
    }
  }

  if (!activeConversation) {
    return (
      <EmptyState
        conversations={allConversations}
        onSelectConversation={(c) => setActiveConversation(c)}
        characters={allCharacters}
        onStartConversation={(p) => startConversation.mutate(p)}
        stories={allStories}
        allCharacters={allCharacters}
        isAdmin={isAdmin}
      />
    );
  }

  const activeChar = characters.find((c) => c.id === activeCharacterId);
  const background = activeConversation.metadata?.background as ConversationBackground | undefined;

  return (
    <div className="flex flex-col h-full relative">
      {/* Header */}
      <div
        className="flex-shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border group"
        style={{ background: 'var(--surface-1)' }}
      >
        {activeChar && <Avatar name={activeChar.name} src={activeChar.avatar} size="sm" expandable />}

        <div className="flex-1 min-w-0">
          {editingTitle ? (
            <input
              autoFocus
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={() => updateTitle.mutate(titleValue)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') updateTitle.mutate(titleValue);
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              className="bg-transparent text-sm font-semibold focus:outline-none border-b border-accent w-full"
            />
          ) : (
            <div className="flex items-center gap-1.5">
              <h1 className="font-semibold text-sm truncate">{activeConversation.title}</h1>
              <button
                onClick={() => setEditingTitle(true)}
                className="p-0.5 rounded hover:bg-white/8 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Pencil size={11} />
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-[10px] text-text-muted shrink-0">
              {activeChar?.name ?? 'Sin personaje'} · {messages.length} mensajes
            </p>
            {/* ── Location indicator / editor ── */}
            <div className="flex items-center min-w-0">
              {locationEditing ? (
                <input
                  autoFocus
                  value={locationValue}
                  onChange={(e) => setLocationValue(e.target.value)}
                  onBlur={saveLocation}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveLocation();
                    if (e.key === 'Escape') {
                      setLocationEditing(false);
                      setLocationValue(activeConversation.currentLocation ?? '');
                    }
                  }}
                  placeholder="Nombre del lugar..."
                  className="bg-transparent text-[10px] text-text-primary focus:outline-none border-b border-accent w-32 placeholder:text-text-muted"
                />
              ) : (
                <button
                  onClick={() => {
                    setLocationValue(activeConversation.currentLocation ?? '');
                    setLocationEditing(true);
                  }}
                  className="flex items-center gap-0.5 text-[10px] transition-colors hover:text-text-primary group/loc"
                  title="Editar ubicación actual de la escena"
                >
                  <MapPin
                    size={9}
                    className={activeConversation.currentLocation ? 'text-accent flex-shrink-0' : 'text-text-muted flex-shrink-0'}
                  />
                  <span className={`truncate max-w-[120px] ${activeConversation.currentLocation ? 'text-accent' : 'text-text-muted opacity-60'}`}>
                    {activeConversation.currentLocation ?? 'Sin ubicación'}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setGalleryOpen(true)}
            className="p-2 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
            title="Galería de imágenes"
          >
            <Images size={15} />
          </button>
          <button
            onClick={() => setSearchOpen(true)}
            className="p-2 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
            title="Buscar en el chat (Ctrl+F)"
          >
            <Search size={15} />
          </button>
          <button
            onClick={() => setAnchorModalOpen(true)}
            className="p-2 rounded-lg hover:bg-white/8 text-text-muted hover:text-accent transition-colors"
            title="Anclar contexto"
          >
            <Pin size={15} />
          </button>
          <button
            onClick={() => setLocationsModalOpen(true)}
            className="p-2 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
            title="Mapa de ubicaciones"
          >
            <Map size={15} />
          </button>
          <button
            onClick={() => setBackgroundModalOpen(true)}
            className="p-2 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
            title="Fondo de la conversación"
          >
            <ImagePlus size={15} />
          </button>
          <button
            onClick={() => setGroupPanelOpen(true)}
            className="p-2 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
            title="Gestionar grupo"
          >
            <Users size={15} />
          </button>

          {/* More menu */}
          <div className="relative" ref={moreMenuRef}>
            <button
              onClick={() => setMoreMenuOpen((v) => !v)}
              className="p-2 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
              title="Más opciones"
            >
              <MoreHorizontal size={15} />
            </button>

            {moreMenuOpen && (
              <div
                className="absolute right-0 top-full mt-1 w-72 rounded-xl border border-border shadow-xl z-50 py-1 animate-slide-up"
                style={{ background: 'var(--surface-2)' }}
              >
                <button
                  onClick={() => { setSummaryModalOpen(true); setMoreMenuOpen(false); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/5 text-left"
                >
                  <BookOpen size={13} className="text-text-muted" />
                  <span className="text-xs text-text-primary">Resumen de sucesos</span>
                </button>
                <button
                  onClick={() => { setContextModalOpen(true); setMoreMenuOpen(false); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/5 text-left"
                >
                  <Zap size={13} className="text-text-muted" />
                  <span className="text-xs text-text-primary">Índice de Contexto</span>
                </button>
                <button
                  onClick={() => { setStatsModalOpen(true); setMoreMenuOpen(false); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/5 text-left"
                >
                  <BarChart2 size={13} className="text-text-muted" />
                  <span className="text-xs text-text-primary">Estadísticas</span>
                </button>
                <div className="my-1 h-px" style={{ background: 'var(--border)' }} />
                <button
                  onClick={() => { setMoreMenuOpen(false); void handleExportChat(); }}
                  disabled={exporting}
                  className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/5 text-left disabled:opacity-50"
                >
                  <Download size={13} className="text-text-muted" />
                  <span className="text-xs text-text-primary">
                    {exporting ? 'Exportando…' : 'Exportar chat (con personajes e historias)'}
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="relative flex-1 flex flex-col min-h-0 overflow-hidden">
        {background && (
          <>
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage: `url(${background.url})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                opacity: background.opacity ?? 1,
              }}
            />
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ background: 'var(--surface-1)', opacity: 1 - (background.opacity ?? 1) }}
            />
          </>
        )}
        <div className="relative flex-1 flex flex-col min-h-0">
          <MessageList
            ref={messageListRef}
            messages={visibleMessages}
            characters={characters}
            highlightedMessageId={highlightedMessageId}
          />
        </div>
      </div>

      {/* ── Bucle de muerte activo: chip informativo con cierre manual ────── */}
      {deathLoop?.status === 'looping' && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-t border-red-500/20" style={{ background: 'rgba(220,38,38,0.06)' }}>
          <Skull size={13} className="text-red-400 flex-shrink-0" />
          <span className="text-[11px] text-red-300/90 flex-1 truncate">
            Bucle de muerte activo — muerte nº {deathLoop.deathCount}
            {deathLoop.lastDeathCause ? ` · ${deathLoop.lastDeathCause}` : ''}. La historia repite la secuencia fatal hasta que la superes.
          </span>
          <button
            onClick={handleDeathClear}
            disabled={deathClearing}
            className="text-[11px] px-2 py-0.5 rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-50 transition-colors flex-shrink-0"
            title="Cierra el bucle manualmente si la IA no lo detecta como superado"
          >
            Dar por superada
          </button>
        </div>
      )}

      {/* ── Muerto: el banner de regreso sustituye al composer ────────────── */}
      {deathLoop?.status === 'dead' ? (
        <div className="px-4 py-4 border-t border-red-500/30" style={{ background: 'rgba(220,38,38,0.10)' }}>
          <div className="flex items-center gap-3 max-w-2xl mx-auto">
            <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 border border-red-500/40" style={{ background: 'rgba(220,38,38,0.15)' }}>
              <Skull size={20} className="text-red-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-red-300">Has muerto</p>
              <p className="text-xs text-text-muted truncate">
                {deathLoop.lastDeathCause ? `Causa: ${deathLoop.lastDeathCause}. ` : ''}
                Puedes regresar a un punto del pasado y volver a vivir la secuencia — quizá esta vez sobrevivas.
              </p>
            </div>
            <button
              onClick={handleDeathRewind}
              disabled={deathRewinding}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-red-600 text-white hover:bg-red-500 disabled:opacity-60 transition-colors flex-shrink-0"
            >
              <RotateCcw size={13} className={deathRewinding ? 'animate-spin' : ''} />
              {deathRewinding ? 'Rebobinando…' : 'Regresar a un punto del pasado'}
            </button>
          </div>
        </div>
      ) : (
        <MessageInput
          characters={characters.length > 0 ? characters : allCharacters}
          activeCharacterId={activeCharacterId}
          onCharacterChange={handleCharacterChange}
          onGameCommand={() => setBattleOpen(true)}
          rightSlot={
            <ContinueStoryButton
              activeCharacterId={activeCharacterId}
              narratorMode={activeConversation.characters.length === 0}
            />
          }
        />
      )}

      <GroupPanel
        open={groupPanelOpen}
        onClose={() => setGroupPanelOpen(false)}
        conversationId={convId!}
        currentCharacterIds={charIds}
        currentStoryIds={activeConversation.stories.map((s) => s.storyId)}
        characterLinks={activeConversation.characters}
        onUpdate={(cids, sids) => updateGroup.mutate({ characterIds: cids, storyIds: sids })}
      />

      <SummaryModal
        open={summaryModalOpen}
        onClose={() => setSummaryModalOpen(false)}
        conversationId={convId!}
        messageCount={activeConversation.messageCount}
      />

      <StatsModal
        open={statsModalOpen}
        onClose={() => setStatsModalOpen(false)}
        conversation={activeConversation}
        messages={messages}
      />

      <ContextModal
        open={contextModalOpen}
        onClose={() => setContextModalOpen(false)}
        conversationId={convId!}
        messages={messages}
      />

      {anchorModalOpen && (
        <ContextAnchorModal
          onClose={() => setAnchorModalOpen(false)}
          onSubmit={async (text) => {
            const msg = await messagesApi.create({
              conversationId: convId!,
              role: 'system',
              content: text,
              metadata: { isAnchor: true },
            });
            addMessage(msg);
          }}
        />
      )}

      {searchOpen && (
        <ChatSearchModal
          messages={messages}
          characters={characters}
          onJumpTo={handleSearchJump}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {galleryOpen && (
        <ImageGalleryModal
          messages={messages}
          onClose={() => setGalleryOpen(false)}
          onJumpTo={(idx, id) => {
            setGalleryOpen(false);
            handleSearchJump(idx, id);
          }}
        />
      )}

      {locationsModalOpen && (
        <LocationsModal
          onClose={() => setLocationsModalOpen(false)}
          storyIds={activeConversation.stories.map((s) => s.storyId)}
          allStories={allStories}
        />
      )}

      {backgroundModalOpen && (
        <BackgroundGeneratorModal
          conversationId={convId!}
          onClose={() => setBackgroundModalOpen(false)}
        />
      )}

      {battleOpen && (
        <BattleModal
          characters={characters}
          user={user}
          partyState={activeConversation.metadata?.partyState as PartyState | undefined}
          onClose={() => setBattleOpen(false)}
          onBattleEnd={async (narrationPrompt, outcome, rewards) => {
            // 1. Compact system anchor visible in chat
            const outcomeLabel =
              outcome === 'victory' ? '⚔️ Victoria' :
              outcome === 'defeat'  ? '☠️ Derrota'  : '🏃 Huida';
            const anchorLines = [outcomeLabel];
            if (rewards.xp > 0) anchorLines.push(`+${rewards.xp} PX · +${rewards.gold} ✦`);
            const msg = await messagesApi.create({
              conversationId: convId!,
              role: 'system',
              content: anchorLines.join('\n'),
              metadata: { isAnchor: true },
            });
            addMessage(msg);
            // 2. Queue prompt — useEffect fires sendMessage once the modal is fully closed
            setPendingNarration(narrationPrompt);
          }}
          onPartyStateChange={async (newPartyState) => {
            const updated = await conversationsApi.updatePartyState(convId!, newPartyState);
            setActiveConversation(updated);
          }}
        />
      )}
    </div>
  );
}

// ─── Context Anchor Modal ────────────────────────────────────────────────────

function ContextAnchorModal({ onClose, onSubmit }: {
  onClose: () => void;
  onSubmit: (text: string) => Promise<void>;
}) {
  const [text, setText] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  async function handleSubmit() {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await onSubmit(text.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.72)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border flex flex-col animate-slide-up"
        style={{ background: 'var(--surface-1)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Pin size={15} className="text-accent" />
            <div>
              <p className="font-semibold text-sm">Anclar contexto</p>
              <p className="text-[10px] text-text-muted mt-0.5">Inserta una nota de estado que la IA verá como fuente autoritativa</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-3">
          <p className="text-xs text-text-muted leading-relaxed">
            Úsalo para corregir alucinaciones: escribe el estado actual del combate, HP de los personajes, ubicación, o cualquier hecho que la IA deba respetar. Aparecerá como una nota fijada en el chat y se incluirá en el contexto.
          </p>
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit(); }}
            className="w-full rounded-lg px-3 py-2.5 text-xs bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-none font-mono leading-relaxed"
            rows={9}
            placeholder={'ESTADO ACTUAL DEL COMBATE:\n- HP Aria: 18 / 30  (herida leve en el brazo)\n- HP Kira: 25 / 30\n- Enemigo: Jefe Goblin — 45 HP restantes, en pie\n- Turno: 3  •  Ubicación: Sala del trono\n- Aria acaba de lanzar Escudo de Maná\n- El Jefe no ha usado su habilidad especial todavía'}
          />
          <p className="text-[10px] text-text-muted">Atajo: ⌘+Enter para anclar</p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary transition-colors">
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={!text.trim() || saving}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-lg font-medium text-white disabled:opacity-50 transition-opacity"
            style={{ background: 'var(--accent)' }}
          >
            <Pin size={13} />
            {saving ? 'Anclando…' : 'Anclar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Locations Modal ─────────────────────────────────────────────────────────

function LocationsModal({ onClose, storyIds, allStories }: {
  onClose: () => void;
  storyIds: string[];
  allStories: Story[];
}) {
  const sendMessage = useChatStore((s) => s.sendMessage);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const linkedStories = allStories.filter((s) => storyIds.includes(s.id));
  const allLocations = linkedStories.flatMap((s) =>
    s.locations.map((loc) => ({ ...loc, storyName: s.name }))
  );

  async function handleMention(locationName: string) {
    onClose();
    await sendMessage({ message: `¿Podéis darme más información sobre ${locationName}?` });
  }

  async function handleGo(locationName: string) {
    onClose();
    await sendMessage({ message: `Vamos a ${locationName}` });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.72)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border flex flex-col animate-slide-up"
        style={{ background: 'var(--surface-1)', maxHeight: '80vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Map size={15} className="text-accent" />
            <div>
              <p className="font-semibold text-sm">Mapa de ubicaciones</p>
              <p className="text-[10px] text-text-muted mt-0.5">
                {allLocations.length === 0
                  ? 'Sin ubicaciones definidas en las historias vinculadas'
                  : `${allLocations.length} ubicación${allLocations.length !== 1 ? 'es' : ''} disponible${allLocations.length !== 1 ? 's' : ''}`}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-3 space-y-2">
          {allLocations.length === 0 ? (
            <div className="py-10 text-center">
              <Map size={28} className="mx-auto mb-3 text-text-muted opacity-40" />
              <p className="text-sm text-text-muted">No hay ubicaciones definidas.</p>
              <p className="text-xs text-text-muted mt-1">Añádelas en el editor de historia → Ubicaciones.</p>
            </div>
          ) : (
            allLocations.map((loc) => (
              <div
                key={loc.id}
                className="rounded-xl border border-border p-3.5 flex flex-col gap-2.5"
                style={{ background: 'var(--surface-2)' }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm leading-tight">{loc.name}</p>
                    {linkedStories.length > 1 && (
                      <p className="text-[10px] text-text-muted mt-0.5">{loc.storyName}</p>
                    )}
                    {loc.description && (
                      <p className="text-xs text-text-muted mt-1 leading-relaxed line-clamp-2">
                        {loc.description}
                      </p>
                    )}
                    {loc.atmosphere && (
                      <p className="text-[10px] text-text-muted italic mt-0.5 line-clamp-1">
                        {loc.atmosphere}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleMention(loc.name)}
                    disabled={isStreaming}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-border hover:bg-white/5 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
                  >
                    <Info size={12} />
                    Mencionar
                  </button>
                  <button
                    onClick={() => handleGo(loc.name)}
                    disabled={isStreaming}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
                    style={{ background: 'var(--accent)', color: '#fff' }}
                  >
                    <Navigation size={12} />
                    Ir
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Confirmation Dialogs ─────────────────────────────────────────────────────

function ConfirmOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.72)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border shadow-2xl animate-slide-up overflow-hidden"
        style={{ background: 'var(--surface-1)' }}
      >
        {children}
      </div>
    </div>
  );
}

/** Confirmación al empezar chat desde un personaje */
function CharacterConfirmDialog({
  char, stories, onClose, onConfirm,
}: {
  char: Character;
  stories: Story[];
  onClose: () => void;
  onConfirm: (p: StartParams) => void;
}) {
  const [selectedStoryId, setSelectedStoryId] = useState('');

  function handleConfirm() {
    const storyIds = selectedStoryId ? [selectedStoryId] : [];
    // Si se selecciona una historia con personajes vinculados, añadirlos también
    const extraCharIds: string[] = [];
    if (selectedStoryId) {
      const story = stories.find(s => s.id === selectedStoryId);
      story?.characters.forEach(l => {
        if (l.characterId !== char.id) extraCharIds.push(l.characterId);
      });
    }
    onConfirm({
      title: `Chat con ${char.name}`,
      characterIds: [char.id, ...extraCharIds],
      storyIds,
    });
  }

  return (
    <ConfirmOverlay onClose={onClose}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <p className="font-semibold text-sm">Nueva conversación</p>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors">
          <X size={15} />
        </button>
      </div>

      {/* Body */}
      <div className="p-5 space-y-4">
        {/* Personaje */}
        <div className="flex items-center gap-3 p-3 rounded-xl border border-border" style={{ background: 'var(--surface-2)' }}>
          <Avatar name={char.name} src={char.avatar} size="md" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm">{char.name}</p>
            {char.description && (
              <p className="text-xs text-text-muted line-clamp-2 mt-0.5 leading-relaxed">
                {char.description.slice(0, 120)}{char.description.length > 120 ? '…' : ''}
              </p>
            )}
          </div>
        </div>

        {/* Historia opcional */}
        {stories.length > 0 && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
              <BookOpen size={12} className="text-accent" />
              Añadir historia (opcional)
            </label>
            <select
              value={selectedStoryId}
              onChange={(e) => setSelectedStoryId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm border border-border appearance-none focus:outline-none focus:ring-1 focus:ring-accent"
              style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
            >
              <option value="">Sin historia</option>
              {stories.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {selectedStoryId && (() => {
              const story = stories.find(s => s.id === selectedStoryId);
              if (!story?.description) return null;
              return <p className="text-[11px] text-text-muted leading-relaxed">{story.description.slice(0, 100)}…</p>;
            })()}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex gap-2 px-5 pb-5">
        <button
          onClick={onClose}
          className="flex-1 py-2 rounded-xl text-sm border border-border text-text-secondary hover:text-text-primary transition-colors"
        >
          Cancelar
        </button>
        <button
          onClick={handleConfirm}
          className="flex-1 py-2 rounded-xl text-sm font-medium transition-colors"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          <MessageSquarePlus size={14} className="inline mr-1.5 -mt-0.5" />
          Empezar conversación
        </button>
      </div>
    </ConfirmOverlay>
  );
}

/** Confirmación al empezar aventura desde una historia */
function StoryConfirmDialog({
  story, allCharacters, onClose, onConfirm,
}: {
  story: Story;
  allCharacters: Character[];
  onClose: () => void;
  onConfirm: (p: StartParams) => void;
}) {
  // Pre-seleccionar personajes vinculados a la historia
  const linkedIds = story.characters.map(l => l.characterId);
  const [selectedCharIds, setSelectedCharIds] = useState<Set<string>>(new Set(linkedIds));

  function toggle(id: string) {
    setSelectedCharIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Personajes vinculados primero, resto después
  const linkedChars   = linkedIds.map(id => allCharacters.find(c => c.id === id)).filter(Boolean) as Character[];
  const unlinkedChars = allCharacters.filter(c => !linkedIds.includes(c.id));

  function handleConfirm() {
    onConfirm({
      title: story.name,
      characterIds: [...selectedCharIds],
      storyIds: [story.id],
    });
  }

  return (
    <ConfirmOverlay onClose={onClose}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          {story.adventureMode
            ? <Sword size={15} className="text-accent" />
            : <BookOpen size={15} className="text-accent" />}
          <p className="font-semibold text-sm">
            {story.adventureMode ? 'Nueva aventura' : 'Nueva historia'}
          </p>
        </div>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors">
          <X size={15} />
        </button>
      </div>

      {/* Body */}
      <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
        {/* Info de la historia */}
        <div className="p-3 rounded-xl border border-border space-y-1" style={{ background: 'var(--surface-2)' }}>
          <p className="font-semibold text-sm">{story.name}</p>
          {story.description && (
            <p className="text-xs text-text-muted leading-relaxed">
              {story.description.slice(0, 200)}{story.description.length > 200 ? '…' : ''}
            </p>
          )}
        </div>

        {/* Personajes */}
        {allCharacters.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
              <Users size={12} className="text-accent" />
              Personajes que participarán
              {linkedChars.length > 0 && (
                <span className="text-text-muted font-normal">({linkedChars.length} sugeridos por la historia)</span>
              )}
            </p>

            {/* Vinculados a la historia */}
            {linkedChars.map((char) => (
              <CharacterToggle key={char.id} char={char} checked={selectedCharIds.has(char.id)}
                linked onChange={() => toggle(char.id)} />
            ))}

            {/* Resto de personajes */}
            {unlinkedChars.length > 0 && (
              <>
                {linkedChars.length > 0 && (
                  <p className="text-[10px] text-text-muted pt-1">Otros personajes disponibles:</p>
                )}
                {unlinkedChars.map((char) => (
                  <CharacterToggle key={char.id} char={char} checked={selectedCharIds.has(char.id)}
                    linked={false} onChange={() => toggle(char.id)} />
                ))}
              </>
            )}

            {selectedCharIds.size === 0 && (
              <p className="text-xs text-amber-400/80 italic">
                Sin personajes seleccionados — el narrador actuará solo.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex gap-2 px-5 pb-5 border-t border-border pt-4">
        <button
          onClick={onClose}
          className="flex-1 py-2 rounded-xl text-sm border border-border text-text-secondary hover:text-text-primary transition-colors"
        >
          Cancelar
        </button>
        <button
          onClick={handleConfirm}
          className="flex-1 py-2 rounded-xl text-sm font-medium transition-colors"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          {story.adventureMode
            ? <><Sword size={13} className="inline mr-1.5 -mt-0.5" />¡Comenzar aventura!</>
            : <><BookOpen size={13} className="inline mr-1.5 -mt-0.5" />Comenzar historia</>
          }
        </button>
      </div>
    </ConfirmOverlay>
  );
}

function CharacterToggle({ char, checked, linked, onChange }: {
  char: Character; checked: boolean; linked: boolean; onChange: () => void;
}) {
  return (
    <button
      onClick={onChange}
      className={`w-full flex items-center gap-3 p-2.5 rounded-xl border transition-all text-left ${
        checked
          ? 'border-accent/50 bg-accent/5'
          : 'border-border hover:border-border/80 opacity-60 hover:opacity-80'
      }`}
    >
      <Avatar name={char.name} src={char.avatar} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium truncate">{char.name}</p>
          {linked && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-accent/15 text-accent font-medium flex-shrink-0">
              vinculado
            </span>
          )}
        </div>
        {char.description && (
          <p className="text-[10px] text-text-muted truncate mt-0.5">{char.description.slice(0, 60)}</p>
        )}
      </div>
      <div className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
        checked ? 'border-accent bg-accent' : 'border-border'
      }`}>
        {checked && <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      </div>
    </button>
  );
}

// ─── Conversation Summary Popup ───────────────────────────────────────────────

function ConvSummaryPopup({
  conv,
  onClose,
  onOpen,
}: {
  conv: Conversation;
  onClose: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.65)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-border shadow-2xl flex flex-col animate-fade-in"
        style={{ background: 'var(--surface-1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <BookOpen size={15} className="text-accent flex-shrink-0" />
            <p className="font-semibold text-sm truncate">{conv.title}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors flex-shrink-0 ml-2"
          >
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto max-h-[60vh]">
          <p className="text-[13px] text-text-secondary leading-relaxed whitespace-pre-wrap">
            {conv.summary}
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
          >
            Cerrar
          </button>
          <button
            onClick={onOpen}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-lg font-medium text-white transition-colors"
            style={{ background: 'var(--accent)' }}
          >
            <MessagesSquare size={13} />
            Abrir conversación
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Continue Story Button ────────────────────────────────────────────────────

function ContinueStoryButton({
  activeCharacterId,
  narratorMode,
}: {
  activeCharacterId: string | null;
  narratorMode: boolean;
}) {
  const { sendMessage, isStreaming } = useChatStore();
  const [sending, setSending] = React.useState(false);

  async function handleClick() {
    if (isStreaming || sending) return;
    setSending(true);
    try {
      await sendMessage({
        message:          'Narrador, avanza la historia. Describe qué ocurre a continuación sin esperar mi intervención.',
        forceNarratorMode: true,   // always narrator, regardless of the selector
      });
    } finally {
      setSending(false);
    }
  }

  if (isStreaming) return null;

  return (
    <button
      onClick={handleClick}
      disabled={sending}
      className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-accent/50 text-accent hover:bg-accent/12 active:scale-95 disabled:opacity-50 transition-all"
      title="Continúa la historia"
    >
      <ChevronRight size={12} />
      Continúa la historia
    </button>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins  <  1) return 'ahora mismo';
  if (mins  < 60) return `hace ${mins} min`;
  if (hours < 24) return `hace ${hours}h`;
  if (days  <  7) return `hace ${days}d`;
  return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

// ─── Empty state / Home screen ────────────────────────────────────────────────

type StartParams = { title: string; characterIds: string[]; storyIds: string[] };

function EmptyState({
  conversations,
  onSelectConversation,
  characters,
  onStartConversation,
  stories,
  allCharacters,
  isAdmin,
}: {
  conversations: Conversation[];
  onSelectConversation: (c: Conversation) => void;
  characters: Character[];
  onStartConversation: (p: StartParams) => void;
  stories: Story[];
  allCharacters: Character[];
  isAdmin?: boolean;
}) {
  const [summaryPopupConv, setSummaryPopupConv] = useState<Conversation | null>(null);
  const [confirmChar,  setConfirmChar]  = useState<Character | null>(null);
  const [confirmStory, setConfirmStory] = useState<Story | null>(null);

  // ── Pestaña activa ───────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'chats' | 'characters' | 'stories'>('chats');

  // ── Importar chat ────────────────────────────────────────────────────────
  const qc = useQueryClient();
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite reimportar el mismo fichero
    if (!file || importing) return;
    setImporting(true);
    try {
      const pkg = JSON.parse(await file.text());
      const created = await conversationsApi.importChat(pkg);
      // Import es aditivo: refresca conversaciones, personajes e historias.
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['characters'] });
      qc.invalidateQueries({ queryKey: ['stories'] });
      onSelectConversation(created); // abre el chat recién importado
    } catch (err) {
      console.error('[import] Error al importar el chat:', err);
      window.alert(
        err instanceof SyntaxError
          ? 'El archivo no es un paquete de chat válido (JSON ilegible).'
          : 'No se pudo importar el chat. Comprueba que el archivo es un export de rpgSpeak.',
      );
    } finally {
      setImporting(false);
    }
  }

  // ── Filtros ────────────────────────────────────────────────────────────────
  const [search, setSearch]           = useState('');
  const [charFilter, setCharFilter]   = useState('');
  const [storyFilter, setStoryFilter] = useState('');
  const [userFilter, setUserFilter]   = useState('');

  const { data: allUsers = [] } = useQuery<User[]>({
    queryKey: ['users-list'],
    queryFn: () => api.get<User[]>('/users'),
    enabled: !!isAdmin,
  });

  const activeFilters = !!(search || charFilter || storyFilter || userFilter);
  function clearFilters() { setSearch(''); setCharFilter(''); setStoryFilter(''); setUserFilter(''); }

  const q = search.trim().toLowerCase();

  // Nombres de los personajes de una conversación (para poder buscar por ellos)
  const convCharNames = useCallback((c: Conversation) =>
    c.characters
      .map((l) => allCharacters.find((ch) => ch.id === l.characterId)?.name ?? '')
      .join(' ')
      .toLowerCase(),
  [allCharacters]);

  // Sort + filter conversations (client-side sobre los datos ya cargados).
  // La búsqueda de texto cubre título, resumen y nombres de personajes.
  const sortedConvs = [...conversations]
    .filter((c) => !c.isArchived)
    .filter((c) => !q ||
      c.title.toLowerCase().includes(q) ||
      (c.summary?.toLowerCase().includes(q) ?? false) ||
      convCharNames(c).includes(q))
    .filter((c) => !charFilter  || c.characters.some((l) => l.characterId === charFilter))
    .filter((c) => !storyFilter || c.stories.some((l) => l.storyId === storyFilter))
    .filter((c) => !userFilter  || c.userId === userFilter)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  // La misma búsqueda de texto aplica a personajes e historias (por nombre y descripción)
  const filteredChars = characters.filter((c) =>
    !q || c.name.toLowerCase().includes(q) || (c.description?.toLowerCase().includes(q) ?? false));
  const filteredStories = stories.filter((s) =>
    !q || s.name.toLowerCase().includes(q) || (s.description?.toLowerCase().includes(q) ?? false));

  const completelyEmpty = characters.length === 0 && stories.length === 0 &&
    [...conversations].filter((c) => !c.isArchived).length === 0;

  const tabs = [
    { id: 'chats'      as const, icon: <MessagesSquare size={15} />, label: 'Chats',       count: sortedConvs.length },
    { id: 'characters' as const, icon: <Users size={15} />,          label: 'Personajes',  count: filteredChars.length },
    { id: 'stories'    as const, icon: <BookOpen size={15} />,       label: 'Historias',   count: filteredStories.length },
  ];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">

        {/* Input oculto para importar — compartido por ambos estados */}
        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={handleImportFile}
        />

        {completelyEmpty ? (
          /* Estado completamente vacío */
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <Zap size={36} className="text-accent opacity-60" />
            <div>
              <h2 className="text-lg font-bold mb-1">Bienvenido a rpgSpeak</h2>
              <p className="text-sm text-text-muted max-w-xs">
                Crea personajes y mundos en las páginas de Personajes e Historias para comenzar a jugar.
              </p>
            </div>
            <button
              onClick={() => importInputRef.current?.click()}
              disabled={importing}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm border border-border text-text-secondary hover:text-accent hover:border-accent/50 transition-colors disabled:opacity-50"
            >
              <Upload size={15} />
              {importing ? 'Importando…' : 'Importar un chat'}
            </button>
          </div>
        ) : (<>

        {/* ── Buscador global (afecta a las tres pestañas) + importar ──────── */}
        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex items-center flex-1">
            <Search size={15} className="absolute left-3 text-text-muted pointer-events-none" />
            <input
              type="text"
              placeholder="Buscar en chats, personajes e historias..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-8 py-2.5 rounded-xl text-sm border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
              style={{ background: 'var(--surface-2)' }}
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 text-text-muted hover:text-text-primary">
                <X size={14} />
              </button>
            )}
          </div>
          <button
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
            title="Importar un chat exportado (con sus personajes e historias)"
            className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm border border-border text-text-secondary hover:text-accent hover:border-accent/50 transition-colors disabled:opacity-50 flex-shrink-0"
          >
            <Upload size={15} />
            <span className="hidden sm:inline">{importing ? 'Importando…' : 'Importar'}</span>
          </button>
        </div>

        {/* ── Pestañas ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-1 p-1 mb-6 rounded-xl border border-border w-full sm:w-fit"
          style={{ background: 'var(--surface-2)' }}>
          {tabs.map((t) => {
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  active ? 'text-white' : 'text-text-muted hover:text-text-primary'
                }`}
                style={active ? { background: 'var(--accent)' } : undefined}
              >
                {t.icon}
                <span>{t.label}</span>
                <span className={`text-[11px] px-1.5 py-0.5 rounded-full tabular-nums ${
                  active ? 'bg-white/20' : 'bg-surface-1 border border-border'
                }`}>
                  {t.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── Pestaña: Chats ───────────────────────────────────────────────── */}
        {activeTab === 'chats' && (
        <section>
          {/* Filtros adicionales de conversaciones */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {/* Historia */}
            <div className="relative flex items-center">
              <select
                value={storyFilter}
                onChange={(e) => setStoryFilter(e.target.value)}
                className="pl-2.5 pr-6 py-1.5 rounded-lg text-xs border border-border appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent"
                style={{ background: 'var(--surface-2)', color: storyFilter ? 'var(--text-primary)' : 'var(--text-muted)', minWidth: '140px' }}
              >
                <option value="">📖 Todas las historias</option>
                {stories.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {storyFilter && (
                <button onClick={() => setStoryFilter('')} className="absolute right-1.5 text-text-muted hover:text-text-primary"><X size={10} /></button>
              )}
            </div>

            {/* Personaje */}
            <div className="relative flex items-center">
              <select
                value={charFilter}
                onChange={(e) => setCharFilter(e.target.value)}
                className="pl-2.5 pr-6 py-1.5 rounded-lg text-xs border border-border appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent"
                style={{ background: 'var(--surface-2)', color: charFilter ? 'var(--text-primary)' : 'var(--text-muted)', minWidth: '140px' }}
              >
                <option value="">👤 Todos los personajes</option>
                {allCharacters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {charFilter && (
                <button onClick={() => setCharFilter('')} className="absolute right-1.5 text-text-muted hover:text-text-primary"><X size={10} /></button>
              )}
            </div>

            {/* Usuario (solo admin) */}
            {isAdmin && allUsers.length > 0 && (
              <div className="relative flex items-center">
                <select
                  value={userFilter}
                  onChange={(e) => setUserFilter(e.target.value)}
                  className="pl-2.5 pr-6 py-1.5 rounded-lg text-xs border border-border appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent"
                  style={{ background: 'var(--surface-2)', color: userFilter ? 'var(--text-primary)' : 'var(--text-muted)', minWidth: '130px' }}
                >
                  <option value="">🧑‍💻 Todos los usuarios</option>
                  {allUsers.map((u) => <option key={u.id} value={u.id}>{u.displayName || u.username}</option>)}
                </select>
                {userFilter && (
                  <button onClick={() => setUserFilter('')} className="absolute right-1.5 text-text-muted hover:text-text-primary"><X size={10} /></button>
                )}
              </div>
            )}

            {activeFilters && (
              <button onClick={clearFilters}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-border text-text-muted hover:text-accent hover:border-accent/50 transition-colors">
                <Filter size={11} /> Limpiar
              </button>
            )}
          </div>

          {sortedConvs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center space-y-2">
              <MessagesSquare size={28} className="text-text-muted mx-auto mb-1 opacity-40" />
              {activeFilters ? (
                <>
                  <p className="text-sm text-text-muted">Ninguna conversación coincide con los filtros.</p>
                  <button onClick={clearFilters} className="text-xs text-accent hover:underline">Limpiar filtros</button>
                </>
              ) : (
                <>
                  <p className="text-sm text-text-muted">Aún no has comenzado ninguna historia.</p>
                  <p className="text-xs text-text-muted opacity-70">
                    Elige un personaje o una historia en las otras pestañas para empezar.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {sortedConvs.map((conv) => {
                const convChars = conv.characters
                  .map((l) => allCharacters.find((c) => c.id === l.characterId))
                  .filter(Boolean) as Character[];
                const hasStory = conv.stories.length > 0;

                return (
                  <div
                    key={conv.id}
                    onClick={() => onSelectConversation(conv)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectConversation(conv); }}
                    className="flex flex-col gap-3 p-4 rounded-xl border border-border hover:border-accent/50 hover:bg-accent/5 transition-all text-left group cursor-pointer"
                    style={{ background: 'var(--surface-2)' }}
                  >
                    {/* Avatars + time + owner badge */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {convChars.length > 0 ? (
                          <div className="flex -space-x-2">
                            {convChars.slice(0, 3).map((c, i) => (
                              <div key={c.id} style={{ zIndex: 3 - i }}>
                                <Avatar name={c.name} src={c.avatar} size="sm" />
                              </div>
                            ))}
                            {convChars.length > 3 && (
                              <div className="w-7 h-7 rounded-full bg-surface-2 border-2 border-surface-1 flex items-center justify-center text-[9px] text-text-muted font-medium" style={{ zIndex: 0 }}>
                                +{convChars.length - 3}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="w-7 h-7 rounded-full bg-surface-2 flex items-center justify-center">
                            {hasStory
                              ? <Sword size={12} className="text-accent" />
                              : <BookOpen size={12} className="text-text-muted" />
                            }
                          </div>
                        )}
                        {/* Badge de usuario (solo admin) */}
                        {isAdmin && conv.ownerName && (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-accent/10 text-accent text-[9px] font-medium leading-none">
                            <UserCircle size={9} />
                            {conv.ownerName}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-text-muted">
                        <Clock size={10} />
                        <span>{relativeTime(conv.updatedAt)}</span>
                      </div>
                    </div>

                    {/* Title */}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm group-hover:text-accent transition-colors line-clamp-2 leading-snug">
                        {conv.title || 'Sin título'}
                      </p>
                      {convChars.length > 0 && (
                        <p className="text-[11px] text-text-muted mt-0.5 truncate">
                          {convChars.map((c) => c.name).join(', ')}
                        </p>
                      )}
                    </div>

                    {/* Summary snippet */}
                    {conv.summary && (
                      <div className="mt-0.5">
                        <p className="text-[11px] text-text-muted leading-relaxed line-clamp-2">
                          {conv.summary}
                        </p>
                        {conv.summary.length > 150 && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setSummaryPopupConv(conv); }}
                            className="mt-0.5 text-[10px] text-accent/70 hover:text-accent font-medium transition-colors"
                          >
                            Ver más
                          </button>
                        )}
                      </div>
                    )}

                    {/* Footer */}
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-text-muted tabular-nums">
                        {conv.messageCount} {conv.messageCount === 1 ? 'mensaje' : 'mensajes'}
                      </span>
                      <ChevronRight size={13} className="text-text-muted group-hover:text-accent transition-colors flex-shrink-0" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        )}

        {/* ── Pestaña: Personajes ──────────────────────────────────────────── */}
        {activeTab === 'characters' && (
          <section>
            {filteredChars.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center space-y-2">
                <Users size={28} className="text-text-muted mx-auto mb-1 opacity-40" />
                {q ? (
                  <>
                    <p className="text-sm text-text-muted">Ningún personaje coincide con la búsqueda.</p>
                    <button onClick={() => setSearch('')} className="text-xs text-accent hover:underline">Limpiar búsqueda</button>
                  </>
                ) : (
                  <p className="text-sm text-text-muted">Aún no hay personajes. Créalos en la página de Personajes.</p>
                )}
              </div>
            ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredChars.map((char) => (
                <button
                  key={char.id}
                  onClick={() => setConfirmChar(char)}
                  className="flex items-center gap-3 p-3.5 rounded-xl border border-border hover:border-accent/50 hover:bg-accent/5 transition-all text-left group"
                  style={{ background: 'var(--surface-2)' }}
                >
                  <Avatar name={char.name} src={char.avatar} size="md" expandable />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm group-hover:text-accent transition-colors truncate">
                      {char.name}
                    </p>
                    {char.description && (
                      <p className="text-xs text-text-muted line-clamp-2 leading-relaxed mt-0.5">
                        {char.description.slice(0, 80)}{char.description.length > 80 ? '…' : ''}
                      </p>
                    )}
                  </div>
                  <MessageSquarePlus size={14} className="text-text-muted group-hover:text-accent flex-shrink-0 transition-colors" />
                </button>
              ))}
            </div>
            )}
          </section>
        )}

        {/* ── Pestaña: Historias ───────────────────────────────────────────── */}
        {activeTab === 'stories' && (
          <section>
            {filteredStories.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center space-y-2">
                <BookOpen size={28} className="text-text-muted mx-auto mb-1 opacity-40" />
                {q ? (
                  <>
                    <p className="text-sm text-text-muted">Ninguna historia coincide con la búsqueda.</p>
                    <button onClick={() => setSearch('')} className="text-xs text-accent hover:underline">Limpiar búsqueda</button>
                  </>
                ) : (
                  <p className="text-sm text-text-muted">Aún no hay historias. Créalas en la página de Historias.</p>
                )}
              </div>
            ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredStories.map((story) => (
                <button
                  key={story.id}
                  onClick={() => setConfirmStory(story)}
                  className="flex items-center gap-3 p-3.5 rounded-xl border border-border hover:border-accent/50 hover:bg-accent/5 transition-all text-left group"
                  style={{ background: 'var(--surface-2)' }}
                >
                  <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center flex-shrink-0">
                    {story.adventureMode
                      ? <Sword size={16} className="text-accent" />
                      : <BookOpen size={16} className="text-accent" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm group-hover:text-accent transition-colors truncate">
                      {story.name}
                    </p>
                    {story.description && (
                      <p className="text-xs text-text-muted line-clamp-2 leading-relaxed mt-0.5">
                        {story.description.slice(0, 80)}{story.description.length > 80 ? '…' : ''}
                      </p>
                    )}
                    {story.adventureMode && (
                      <span className="inline-flex items-center gap-1 mt-1 text-[10px] text-accent/80">
                        <Sword size={9} /> Modo Aventura
                      </span>
                    )}
                  </div>
                  <ChevronRight size={14} className="text-text-muted group-hover:text-accent flex-shrink-0 transition-colors" />
                </button>
              ))}
            </div>
            )}
          </section>
        )}

        </>)}

      </div>

      {/* Summary popup */}
      {summaryPopupConv && (
        <ConvSummaryPopup
          conv={summaryPopupConv}
          onClose={() => setSummaryPopupConv(null)}
          onOpen={() => { onSelectConversation(summaryPopupConv); setSummaryPopupConv(null); }}
        />
      )}

      {/* Confirmación: nuevo chat con personaje */}
      {confirmChar && (
        <CharacterConfirmDialog
          char={confirmChar}
          stories={stories}
          onClose={() => setConfirmChar(null)}
          onConfirm={(p) => { onStartConversation(p); setConfirmChar(null); }}
        />
      )}

      {/* Confirmación: nueva aventura con historia */}
      {confirmStory && (
        <StoryConfirmDialog
          story={confirmStory}
          allCharacters={allCharacters}
          onClose={() => setConfirmStory(null)}
          onConfirm={(p) => { onStartConversation(p); setConfirmStory(null); }}
        />
      )}
    </div>
  );
}
