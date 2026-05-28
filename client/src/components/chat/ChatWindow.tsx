import React, { useEffect, useState, useRef } from 'react';
import { MessageList, type MessageListHandle } from './MessageList.tsx';
import { MessageInput } from './MessageInput.tsx';
import { GroupPanel } from './GroupPanel.tsx';
import { SummaryModal } from './SummaryModal.tsx';
import { ContextModal } from './ContextModal.tsx';
import { StatsModal } from './StatsModal.tsx';
import { ChatSearchModal } from './ChatSearchModal.tsx';
import { useChatStore } from '../../stores/chat.store.ts';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { messagesApi, conversationsApi } from '../../api/conversations.ts';
import { charactersApi } from '../../api/characters.ts';
import { storiesApi } from '../../api/stories.ts';
import {
  MessageSquarePlus,
  Users,
  MoreHorizontal,
  Pencil,
  Zap,
  BookOpen,
  BarChart2,
  Pin,
  X,
  Sword,
  Search,
  Clock,
  MessagesSquare,
  ChevronRight,
} from 'lucide-react';
import { Avatar } from '../ui/Avatar.tsx';
import type { Character, Story, Conversation } from '@rpgspeak/shared';

export function ChatWindow() {
  const {
    activeConversation, setMessages, messages, setActiveConversation,
    addMessage,
  } = useChatStore();
  const qc = useQueryClient();
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState('');

  // Panel / modal states
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const [statsModalOpen, setStatsModalOpen] = useState(false);
  const [contextModalOpen, setContextModalOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [anchorModalOpen, setAnchorModalOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<MessageListHandle>(null);

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

  const startChat = useMutation({
    mutationFn: (char: Character) =>
      conversationsApi.create({ title: `Chat con ${char.name}`, characterIds: [char.id] }),
    onSuccess: (conv) => {
      setActiveConversation(conv);
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const startAdventure = useMutation({
    mutationFn: (story: Story) =>
      conversationsApi.create({ title: story.name, storyIds: [story.id] }),
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

  function handleCharacterChange(id: string) {
    setActiveCharacterId(id);
    updateActiveChar.mutate(id);
  }

  if (!activeConversation) {
    return (
      <EmptyState
        conversations={allConversations}
        onSelectConversation={(c) => setActiveConversation(c)}
        characters={allCharacters}
        onStartChat={(c) => startChat.mutate(c)}
        stories={allStories}
        onStartAdventure={(s) => startAdventure.mutate(s)}
        allCharacters={allCharacters}
      />
    );
  }

  const activeChar = characters.find((c) => c.id === activeCharacterId);

  return (
    <div className="flex flex-col h-full">
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
          <p className="text-[10px] text-text-muted">
            {activeChar?.name ?? 'Sin personaje'} · {messages.length} mensajes
          </p>
        </div>

        <div className="flex items-center gap-1">
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
              </div>
            )}
          </div>
        </div>
      </div>

      <MessageList
        ref={messageListRef}
        messages={messages}
        characters={characters}
        highlightedMessageId={highlightedMessageId}
      />

      <MessageInput
        characters={characters.length > 0 ? characters : allCharacters}
        activeCharacterId={activeCharacterId}
        onCharacterChange={handleCharacterChange}
      />

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
        summary={activeConversation.summary ?? null}
        conversationId={convId!}
        onSummaryUpdated={(s) => setActiveConversation({ ...activeConversation, summary: s })}
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

function SectionHeader({ icon, title, count }: { icon: React.ReactNode; title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2.5 mb-4">
      <div className="text-accent">{icon}</div>
      <h2 className="text-sm font-semibold text-text-primary tracking-tight">{title}</h2>
      {count !== undefined && (
        <span className="ml-1 text-[11px] text-text-muted bg-surface-2 border border-border px-1.5 py-0.5 rounded-full tabular-nums">
          {count}
        </span>
      )}
      <div className="flex-1 h-px ml-2" style={{ background: 'var(--border)' }} />
    </div>
  );
}

// ─── Empty state / Home screen ────────────────────────────────────────────────

function EmptyState({
  conversations,
  onSelectConversation,
  characters,
  onStartChat,
  stories,
  onStartAdventure,
  allCharacters,
}: {
  conversations: Conversation[];
  onSelectConversation: (c: Conversation) => void;
  characters: Character[];
  onStartChat: (c: Character) => void;
  stories: Story[];
  onStartAdventure: (s: Story) => void;
  allCharacters: Character[];
}) {
  const [summaryPopupConv, setSummaryPopupConv] = useState<Conversation | null>(null);

  // Sort conversations by updatedAt desc (most recent first)
  const sortedConvs = [...conversations]
    .filter((c) => !c.isArchived)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-10">

        {/* ── 1. Historias comenzadas ──────────────────────────────────────── */}
        <section>
          <SectionHeader
            icon={<MessagesSquare size={16} />}
            title="Historias comenzadas"
            count={sortedConvs.length}
          />

          {sortedConvs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center space-y-2">
              <MessagesSquare size={28} className="text-text-muted mx-auto mb-1 opacity-40" />
              <p className="text-sm text-text-muted">Aún no has comenzado ninguna historia.</p>
              <p className="text-xs text-text-muted opacity-70">
                Elige un personaje o una historia de las secciones de abajo para empezar.
              </p>
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
                    style={{ background: 'var(--surface-1)' }}
                  >
                    {/* Avatars + mode badge */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center">
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

        {/* ── 2. Personajes para comenzar una charla ──────────────────────── */}
        {characters.length > 0 && (
          <section>
            <SectionHeader
              icon={<Users size={16} />}
              title="Personajes para comenzar una charla"
              count={characters.length}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {characters.map((char) => (
                <button
                  key={char.id}
                  onClick={() => onStartChat(char)}
                  className="flex items-center gap-3 p-3.5 rounded-xl border border-border hover:border-accent/50 hover:bg-accent/5 transition-all text-left group"
                  style={{ background: 'var(--surface-1)' }}
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
          </section>
        )}

        {/* ── 3. Historias para empezar algo nuevo ────────────────────────── */}
        {stories.length > 0 && (
          <section>
            <SectionHeader
              icon={<BookOpen size={16} />}
              title="Historias para empezar algo nuevo"
              count={stories.length}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {stories.map((story) => (
                <button
                  key={story.id}
                  onClick={() => onStartAdventure(story)}
                  className="flex items-center gap-3 p-3.5 rounded-xl border border-border hover:border-accent/50 hover:bg-accent/5 transition-all text-left group"
                  style={{ background: 'var(--surface-1)' }}
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
          </section>
        )}

        {/* Estado completamente vacío */}
        {characters.length === 0 && stories.length === 0 && sortedConvs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <Zap size={36} className="text-accent opacity-60" />
            <div>
              <h2 className="text-lg font-bold mb-1">Bienvenido a rpgSpeak</h2>
              <p className="text-sm text-text-muted max-w-xs">
                Crea personajes y mundos en las páginas de Personajes e Historias para comenzar a jugar.
              </p>
            </div>
          </div>
        )}

      </div>

      {/* Summary popup */}
      {summaryPopupConv && (
        <ConvSummaryPopup
          conv={summaryPopupConv}
          onClose={() => setSummaryPopupConv(null)}
          onOpen={() => { onSelectConversation(summaryPopupConv); setSummaryPopupConv(null); }}
        />
      )}
    </div>
  );
}
