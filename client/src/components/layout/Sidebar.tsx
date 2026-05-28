import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  MessageSquare, Users, BookOpen, Settings, ChevronLeft, ChevronRight, Plus, Zap,
  MoreHorizontal, Trash2, AlertTriangle, Sword, ChevronDown, ChevronUp, LogOut, KeyRound, X,
} from 'lucide-react';
import { useUiStore } from '../../stores/ui.store.ts';
import { useChatStore } from '../../stores/chat.store.ts';
import { useAuthStore } from '../../stores/auth.store.ts';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { conversationsApi } from '../../api/conversations.ts';
import { charactersApi } from '../../api/characters.ts';
import { storiesApi } from '../../api/stories.ts';
import { authApi } from '../../api/auth.ts';
import { Avatar } from '../ui/Avatar.tsx';
import type { Character, Conversation } from '@rpgspeak/shared';

interface SidebarProps {
  collapsed: boolean;
  isMobile?: boolean;
}

const NAV = [
  { icon: MessageSquare, label: 'Chats',      path: '/' },
  { icon: Users,         label: 'Characters', path: '/characters' },
  { icon: BookOpen,      label: 'Stories',    path: '/stories' },
  { icon: Settings,      label: 'Settings',   path: '/settings' },
];

export function Sidebar({ collapsed, isMobile = false }: SidebarProps) {
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const currentUser = useAuthStore((s) => s.user);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const clearUserPrefs = useUiStore((s) => s.clearUserPrefs);
  const setMobileSidebarOpen = useUiStore((s) => s.setMobileSidebarOpen);
  const [changePwdOpen, setChangePwdOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const activeConversation = useChatStore((s) => s.activeConversation);
  const qc = useQueryClient();
  const [adventurePanelOpen, setAdventurePanelOpen] = useState(true);

  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => conversationsApi.list(),
  });

  const { data: allCharacters = [] } = useQuery({
    queryKey: ['characters'],
    queryFn: () => charactersApi.list(),
  });

  const { data: allStories = [] } = useQuery({
    queryKey: ['stories'],
    queryFn: () => storiesApi.list(),
  });

  const charIds = activeConversation?.characters.map((c) => c.characterId) ?? [];
  const convCharacters = charIds.length > 0
    ? allCharacters.filter((c) => charIds.includes(c.id))
    : [];

  const isAdventureActive = activeConversation?.stories.some(
    (s) => allStories.find((st) => st.id === s.storyId)?.adventureMode
  ) ?? false;

  const createConv = useMutation({
    mutationFn: () => conversationsApi.create({ title: 'New Conversation' }),
    onSuccess: (conv) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      setActiveConversation(conv);
      navigate('/');
    },
  });

  return (
    <div className="flex flex-col h-full">
      {/* Logo + toggle */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-border">
        {/* Logo — always visible on mobile, visible on desktop when not collapsed */}
        {(isMobile || !collapsed) && (
          <div className="flex items-center gap-2">
            <Zap size={18} className="text-accent" />
            <span className="font-bold text-sm tracking-tight">rpgSpeak</span>
          </div>
        )}

        {/* Mobile: close (X) button — Desktop: collapse chevron */}
        {isMobile ? (
          <button
            onClick={() => setMobileSidebarOpen(false)}
            className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors ml-auto"
            aria-label="Cerrar menú"
          >
            <X size={18} />
          </button>
        ) : (
          <button
            onClick={toggleSidebar}
            className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors ml-auto"
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="p-2 space-y-0.5 border-b border-border">
        {NAV.map(({ icon: Icon, label, path }) => {
          const active = location.pathname === path;
          return (
            <button
              key={path}
              onClick={() => {
                navigate(path);
                // Clicking the Chats nav item always goes to the home screen
                if (path === '/') setActiveConversation(null);
                if (isMobile) setMobileSidebarOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-2.5 py-2.5 rounded-lg text-sm transition-colors
                ${active
                  ? 'bg-accent-muted text-accent'
                  : 'text-text-secondary hover:text-text-primary hover:bg-white/5'
                }`}
              title={collapsed ? label : undefined}
            >
              <Icon size={16} className="flex-shrink-0" />
              {!collapsed && <span>{label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Conversations list (only on chat route) */}
      {!collapsed && location.pathname === '/' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium text-text-muted uppercase tracking-wider">Conversations</span>
            <button
              onClick={() => createConv.mutate()}
              className="p-1 rounded hover:bg-white/8 text-text-muted hover:text-accent transition-colors"
              title="New conversation"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
            {conversations.map((conv) => (
              <ConversationItem
                key={conv.id}
                conv={conv}
                active={conv.id === activeConversationId}
                onSelect={() => {
                  setActiveConversation(conv);
                  navigate('/');
                  if (isMobile) setMobileSidebarOpen(false);
                }}
                onDeleted={() => {
                  if (conv.id === activeConversationId) {
                    setActiveConversation(null);
                  }
                  qc.invalidateQueries({ queryKey: ['conversations'] });
                }}
              />
            ))}
            {conversations.length === 0 && (
              <div className="py-8 text-center text-xs text-text-muted">
                No conversations yet.
                <br />
                Click + to start one.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Adventure Status Panel — only when not collapsed and adventure active */}
      {!collapsed && isAdventureActive && activeConversation && (
        <AdventureSidebarPanel
          characters={convCharacters}
          allCharacters={allCharacters}
          conversation={activeConversation}
          allStories={allStories}
          open={adventurePanelOpen}
          onToggle={() => setAdventurePanelOpen((v) => !v)}
        />
      )}

      {/* User footer + logout */}
      <div className="mt-auto border-t border-border flex-shrink-0">
        {collapsed ? (
          <div className="flex flex-col items-center gap-1 py-3">
            <button
              onClick={() => setChangePwdOpen(true)}
              title="Cambiar contraseña"
              className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
            >
              <KeyRound size={14} />
            </button>
            <button
              onClick={() => { qc.clear(); setActiveConversation(null); clearUserPrefs(); clearAuth(); }}
              title="Cerrar sesión"
              className="p-1.5 rounded-lg hover:bg-red-500/10 text-text-muted hover:text-red-400 transition-colors"
            >
              <LogOut size={14} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-3 py-3">
            {/* Avatar/initials */}
            <div className="w-7 h-7 rounded-full bg-accent-muted flex items-center justify-center text-[11px] font-bold text-accent flex-shrink-0">
              {(currentUser?.displayName ?? currentUser?.username ?? '?').charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-text-primary truncate leading-none">
                {currentUser?.displayName ?? currentUser?.username}
              </p>
              {isAdmin && (
                <p className="text-[10px] text-accent leading-none mt-0.5">Admin</p>
              )}
            </div>
            <button
              onClick={() => setChangePwdOpen(true)}
              title="Cambiar contraseña"
              className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors flex-shrink-0"
            >
              <KeyRound size={14} />
            </button>
            <button
              onClick={() => { qc.clear(); setActiveConversation(null); clearUserPrefs(); clearAuth(); }}
              title="Cerrar sesión"
              className="p-1.5 rounded-lg hover:bg-red-500/10 text-text-muted hover:text-red-400 transition-colors flex-shrink-0"
            >
              <LogOut size={14} />
            </button>
          </div>
        )}
      </div>

      {changePwdOpen && (
        <ChangePasswordModal onClose={() => setChangePwdOpen(false)} />
      )}
    </div>
  );
}

// ─── Adventure Sidebar Panel ──────────────────────────────────────────────────

function AdventureSidebarPanel({
  characters, allCharacters, conversation, allStories, open, onToggle,
}: {
  characters: Character[];
  allCharacters: Character[];
  conversation: Conversation;
  allStories: import('@rpgspeak/shared').Story[];
  open: boolean;
  onToggle: () => void;
}) {
  const objectives: string[] = [];
  for (const link of conversation.stories) {
    const story = allStories.find((s) => s.id === link.storyId);
    if (story?.stateVariables) {
      for (const [k, v] of Object.entries(story.stateVariables)) {
        if (k.startsWith('objetivo_') || k.startsWith('mision_')) {
          objectives.push(String(v));
        }
      }
    }
  }

  return (
    <div className="border-t border-border flex-shrink-0" style={{ background: 'var(--surface-1)' }}>
      {/* Collapsible header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-white/4 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Sword size={12} className="text-accent" />
          <span className="text-[11px] font-semibold text-accent uppercase tracking-wider">Aventura activa</span>
        </div>
        {open
          ? <ChevronDown size={12} className="text-text-muted" />
          : <ChevronUp size={12} className="text-text-muted" />}
      </button>

      {open && (
        <div className="overflow-y-auto" style={{ maxHeight: '280px' }}>
          <div className="px-3 pb-3 space-y-3">
            {/* HP bars */}
            {characters.length > 0 && (
              <div className="space-y-2.5">
                <p className="text-[9px] uppercase tracking-widest text-text-muted font-semibold pt-0.5">Personajes</p>
                {characters.map((char) => {
                  const full = allCharacters.find((c) => c.id === char.id) ?? char;
                  const hp = full.rpgStats?.hp;
                  const maxHp = full.rpgStats?.maxHp;
                  const hasHp = hp !== undefined && maxHp !== undefined && maxHp > 0;
                  const ratio = hasHp ? Math.max(0, Math.min(1, hp! / maxHp!)) : null;
                  const barColor = ratio === null ? ''
                    : ratio > 0.6 ? '#22c55e'
                    : ratio > 0.3 ? '#eab308'
                    : '#ef4444';
                  return (
                    <div key={char.id} className="flex items-center gap-2.5">
                      <div className="w-6 h-6 rounded-full bg-accent-muted flex items-center justify-center text-[9px] font-bold text-accent flex-shrink-0">
                        {char.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[11px] text-text-primary font-medium truncate leading-none">{char.name}</span>
                          {hasHp && (
                            <span className="text-[9px] text-text-muted flex-shrink-0 ml-1 font-mono">{hp}/{maxHp}</span>
                          )}
                        </div>
                        <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                          {ratio !== null ? (
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{ width: `${ratio * 100}%`, background: barColor }}
                            />
                          ) : (
                            <div className="h-full w-full rounded-full opacity-30" style={{ background: 'var(--accent)' }} />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Objectives — full text, no truncation */}
            {objectives.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[9px] uppercase tracking-widest text-text-muted font-semibold">Objetivos</p>
                {objectives.map((obj, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0 mt-1.5" />
                    <p className="text-[11px] text-text-secondary leading-relaxed">{obj}</p>
                  </div>
                ))}
              </div>
            )}

            {characters.length === 0 && objectives.length === 0 && (
              <p className="text-[10px] text-text-muted italic py-1">Sin datos de aventura configurados.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Change Password Modal ────────────────────────────────────────────────────

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 4) { setError('La nueva contraseña debe tener al menos 4 caracteres.'); return; }
    if (next !== confirm)  { setError('Las contraseñas nuevas no coinciden.'); return; }
    setLoading(true);
    try {
      await authApi.changePassword(current, next);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cambiar la contraseña');
    } finally {
      setLoading(false);
    }
  }

  const inputCls = 'w-full rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.72)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border flex flex-col animate-slide-up"
        style={{ background: 'var(--surface-1)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <KeyRound size={15} className="text-accent" />
            <p className="font-semibold text-sm">Cambiar contraseña</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-3">
          {success ? (
            <div className="py-4 text-center space-y-2">
              <p className="text-sm text-emerald-400 font-medium">✓ Contraseña actualizada correctamente</p>
              <button
                type="button"
                onClick={onClose}
                className="mt-2 px-4 py-1.5 rounded-lg text-sm bg-accent text-white hover:bg-accent-hover transition-colors"
              >
                Cerrar
              </button>
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-text-secondary">Contraseña actual</label>
                <input
                  type="password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  className={inputCls}
                  placeholder="••••••••"
                  autoFocus
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-text-secondary">Nueva contraseña</label>
                <input
                  type="password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  className={inputCls}
                  placeholder="••••••••"
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-text-secondary">Confirmar nueva contraseña</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className={inputCls}
                  placeholder="••••••••"
                  required
                />
              </div>

              {error && (
                <p className="text-xs text-red-400">{error}</p>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 py-2 rounded-lg text-sm border border-border text-text-muted hover:text-text-primary transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={loading || !current || !next || !confirm}
                  className="flex-1 py-2 rounded-lg text-sm bg-accent text-white hover:bg-accent-hover disabled:opacity-40 transition-colors"
                >
                  {loading ? 'Guardando…' : 'Guardar'}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function ConversationItem({
  conv,
  active,
  onSelect,
  onDeleted,
}: {
  conv: Conversation;
  active: boolean;
  onSelect: () => void;
  onDeleted: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Cierra el menú si se hace clic fuera
  useEffect(() => {
    if (!menuOpen) return;
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const deleteMutation = useMutation({
    mutationFn: () => conversationsApi.delete(conv.id),
    onSuccess: () => {
      setConfirmOpen(false);
      onDeleted();
    },
  });

  return (
    <>
      <div
        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors group relative
          ${active ? 'bg-accent-muted' : 'hover:bg-white/5'}`}
      >
        {/* Área principal — selecciona la conversación */}
        <button className="flex items-center gap-2.5 flex-1 min-w-0 text-left" onClick={onSelect}>
          <Avatar name={conv.title} size="xs" />
          <div className="flex-1 min-w-0">
            <p className={`text-xs font-medium truncate ${active ? 'text-accent' : 'text-text-primary'}`}>
              {conv.title}
            </p>
            <p className="text-[10px] text-text-muted">
              {conv.messageCount} {conv.messageCount === 1 ? 'mensaje' : 'mensajes'}
            </p>
          </div>
        </button>

        {/* Botón ··· — visible solo en hover o cuando el menú está abierto */}
        <div className="relative flex-shrink-0" ref={menuRef}>
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            className={`p-1 rounded hover:bg-white/10 text-text-muted hover:text-text-primary transition-colors
              ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
            title="Opciones"
          >
            <MoreHorizontal size={13} />
          </button>

          {menuOpen && (
            <div
              className="absolute right-0 top-full mt-1 w-44 rounded-xl border border-border shadow-xl z-50 py-1 animate-slide-up"
              style={{ background: 'var(--surface-2)' }}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  setConfirmOpen(true);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-red-500/10 text-left group/del"
              >
                <Trash2 size={13} className="text-text-muted group-hover/del:text-red-400 transition-colors" />
                <span className="text-xs text-text-primary group-hover/del:text-red-400 transition-colors">
                  Eliminar conversación
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Modal de confirmación */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="w-full max-w-sm mx-4 rounded-2xl border border-border shadow-2xl p-6 space-y-4"
            style={{ background: 'var(--surface-1)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Icono de advertencia */}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={20} className="text-red-400" />
              </div>
              <div>
                <h2 className="font-semibold text-sm text-text-primary">Eliminar conversación</h2>
                <p className="text-xs text-text-muted mt-0.5">Esta acción no se puede deshacer</p>
              </div>
            </div>

            {/* Mensaje */}
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 space-y-1">
              <p className="text-sm text-text-primary font-medium">"{conv.title}"</p>
              <p className="text-xs text-text-muted">
                Se eliminarán permanentemente{' '}
                <span className="text-red-400 font-semibold">
                  {conv.messageCount} {conv.messageCount === 1 ? 'mensaje' : 'mensajes'}
                </span>
                {' '}y todo el historial de esta conversación.
              </p>
            </div>

            {/* Botones */}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setConfirmOpen(false)}
                className="flex-1 py-2 rounded-xl text-sm border border-border text-text-secondary hover:text-text-primary hover:border-accent/40 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                className="flex-1 py-2 rounded-xl text-sm bg-red-600 hover:bg-red-700 text-white font-medium transition-colors disabled:opacity-60"
              >
                {deleteMutation.isPending ? 'Eliminando…' : 'Sí, eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
