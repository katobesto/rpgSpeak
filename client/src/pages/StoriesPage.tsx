import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { storiesApi } from '../api/stories.ts';
import { charactersApi } from '../api/characters.ts';
import { api } from '../api/client.ts';
import { StoryEditor } from '../components/stories/StoryEditor.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { Plus, Edit2, Trash2, BookOpen, ToggleLeft, ToggleRight, UserCircle, Lock, Eye, Users, X, Search, FileText, Filter } from 'lucide-react';
import type { Story, User } from '@rpgspeak/shared';
import { useAuthStore } from '../stores/auth.store.ts';

function useDebounce<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function StoriesPage() {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingStory, setEditingStory] = useState<Story | null>(null);
  const [previewStory, setPreviewStory] = useState<Story | null>(null);

  // Filtros
  const [searchInput, setSearchInput]       = useState('');
  const [textInput, setTextInput]           = useState('');
  const [charFilter, setCharFilter]         = useState('');
  const [userFilter, setUserFilter]         = useState('');

  const search = useDebounce(searchInput);
  const text   = useDebounce(textInput);

  const qc = useQueryClient();
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const { data: allCharacters = [] } = useQuery({
    queryKey: ['characters'],
    queryFn: () => charactersApi.list(),
  });

  const { data: allUsers = [] } = useQuery<User[]>({
    queryKey: ['users-list'],
    queryFn: () => api.get<User[]>('/users'),
    enabled: isAdmin,
  });

  const activeFilters = !!(search || text || charFilter || userFilter);

  const { data: stories = [], isLoading } = useQuery({
    queryKey: ['stories', search, text, charFilter, userFilter],
    queryFn: () => storiesApi.list({
      search:       search   || undefined,
      text:         text     || undefined,
      characterId:  charFilter || undefined,
      filterUserId: userFilter  || undefined,
    }),
  });

  function clearFilters() {
    setSearchInput('');
    setTextInput('');
    setCharFilter('');
    setUserFilter('');
  }

  const toggleActive = useMutation({
    mutationFn: (story: Story) => storiesApi.update(story.id, { isActive: !story.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stories'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => storiesApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stories'] }),
  });

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-border"
        style={{ background: 'var(--surface-1)' }}>
        <div>
          <h1 className="text-lg font-semibold">Historias</h1>
          <p className="text-xs text-text-muted">{stories.length} {stories.length === 1 ? 'historia' : 'historias'}</p>
        </div>
        <Button size="sm" onClick={() => { setEditingStory(null); setEditorOpen(true); }}>
          <Plus size={14} /> Nueva Historia
        </Button>
      </div>

      {/* ── Barra de filtros ── */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-2 px-6 py-3 border-b border-border"
        style={{ background: 'var(--surface-2)' }}>

        {/* Búsqueda por título */}
        <div className="relative flex items-center flex-1 min-w-[140px]">
          <Search size={13} className="absolute left-2.5 text-text-muted pointer-events-none" />
          <input
            type="text"
            placeholder="Buscar por título..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full pl-7 pr-6 py-1.5 rounded-lg text-xs border border-border bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {searchInput && (
            <button onClick={() => setSearchInput('')} className="absolute right-2 text-text-muted hover:text-text-primary">
              <X size={11} />
            </button>
          )}
        </div>

        {/* Filtro por personaje */}
        <div className="relative flex items-center">
          <Users size={13} className="absolute left-2.5 text-text-muted pointer-events-none" />
          <select
            value={charFilter}
            onChange={(e) => setCharFilter(e.target.value)}
            className="pl-7 pr-6 py-1.5 rounded-lg text-xs border border-border appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent"
            style={{ background: 'var(--surface-1)', color: charFilter ? 'var(--text-primary)' : 'var(--text-muted)', minWidth: '140px' }}
          >
            <option value="">Todos los personajes</option>
            {allCharacters.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {charFilter && (
            <button onClick={() => setCharFilter('')} className="absolute right-2 text-text-muted hover:text-text-primary">
              <X size={11} />
            </button>
          )}
        </div>

        {/* Filtro por usuario (solo admin) */}
        {isAdmin && allUsers.length > 0 && (
          <div className="relative flex items-center">
            <UserCircle size={13} className="absolute left-2.5 text-text-muted pointer-events-none" />
            <select
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              className="pl-7 pr-6 py-1.5 rounded-lg text-xs border border-border appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent"
              style={{ background: 'var(--surface-1)', color: userFilter ? 'var(--text-primary)' : 'var(--text-muted)', minWidth: '130px' }}
            >
              <option value="">Todos los usuarios</option>
              {allUsers.map((u) => (
                <option key={u.id} value={u.id}>{u.displayName || u.username}</option>
              ))}
            </select>
            {userFilter && (
              <button onClick={() => setUserFilter('')} className="absolute right-2 text-text-muted hover:text-text-primary">
                <X size={11} />
              </button>
            )}
          </div>
        )}

        {/* Búsqueda en contenido */}
        <div className="relative flex items-center flex-1 min-w-[160px]">
          <FileText size={13} className="absolute left-2.5 text-text-muted pointer-events-none" />
          <input
            type="text"
            placeholder="Buscar en contenido..."
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            className="w-full pl-7 pr-6 py-1.5 rounded-lg text-xs border border-border bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {textInput && (
            <button onClick={() => setTextInput('')} className="absolute right-2 text-text-muted hover:text-text-primary">
              <X size={11} />
            </button>
          )}
        </div>

        {/* Borrar todos */}
        {activeFilters && (
          <button
            onClick={clearFilters}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-border text-text-muted hover:text-text-primary hover:border-accent/50 transition-colors"
          >
            <Filter size={11} /> Limpiar
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">Loading...</div>
        ) : stories.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="w-16 h-16 rounded-2xl bg-accent-muted flex items-center justify-center">
              <BookOpen size={28} className="text-accent" />
            </div>
            {activeFilters ? (
              <div className="text-center">
                <p className="font-medium">Sin resultados</p>
                <p className="text-text-muted text-sm mt-1">Ninguna historia coincide con los filtros aplicados.</p>
                <button onClick={clearFilters} className="mt-3 text-xs text-accent hover:underline">
                  Limpiar filtros
                </button>
              </div>
            ) : (
              <div className="text-center">
                <p className="font-medium">Aún no hay historias</p>
                <p className="text-text-muted text-sm mt-1">Crea una historia para añadir contexto y reglas a las conversaciones.</p>
              </div>
            )}
            {!activeFilters && (
              <Button onClick={() => { setEditingStory(null); setEditorOpen(true); }}>
                <Plus size={14} /> Crear Historia
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {stories.map((story) => {
              const canEdit = isAdmin || story.userId === currentUserId;
              return (
              <div key={story.id}
                className="rounded-xl border border-border overflow-hidden transition-all hover:border-accent/40"
                style={{ background: 'var(--surface-1)' }}>
                <div className="h-1 bg-gradient-to-r from-emerald-600 to-teal-600" />
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-sm truncate">{story.name}</h3>
                        {!canEdit && (
                          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-surface-2 text-text-muted flex-shrink-0">
                            <Lock size={9} /> Solo lectura
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-text-muted mt-0.5 truncate-2 leading-relaxed">
                        {story.description || 'No description'}
                      </p>
                    </div>
                    {canEdit && (
                      <button
                        onClick={() => toggleActive.mutate(story)}
                        className={`flex-shrink-0 transition-colors ${story.isActive ? 'text-emerald-400' : 'text-text-muted hover:text-text-primary'}`}
                        title={story.isActive ? 'Active' : 'Inactive'}
                      >
                        {story.isActive ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                      </button>
                    )}
                  </div>

                  {/* Linked character avatars */}
                  {story.characters.length > 0 && (() => {
                    const linked = story.characters
                      .map((l) => allCharacters.find((c) => c.id === l.characterId))
                      .filter(Boolean);
                    if (linked.length === 0) return null;
                    return (
                      <div className="flex items-center gap-1 mt-3">
                        <div className="flex -space-x-1.5">
                          {linked.slice(0, 5).map((char) => char && (
                            <Avatar key={char.id} name={char.name} src={char.avatar} size="xs"
                              className="ring-2 ring-[var(--surface-1)]" />
                          ))}
                        </div>
                        {linked.length > 5 && (
                          <span className="text-[10px] text-text-muted ml-1">+{linked.length - 5}</span>
                        )}
                        {story.characters[0]?.role && (
                          <span className="text-[10px] text-text-muted ml-1 italic truncate max-w-[80px]">
                            {story.characters[0].role}
                          </span>
                        )}
                      </div>
                    );
                  })()}

                  <div className="flex items-center gap-2 mt-3 text-[10px] text-text-muted">
                    <span>{story.persistentEvents.length} events</span>
                    <span>·</span>
                    <span>{Object.keys(story.stateVariables).length} variables</span>
                    <span>·</span>
                    <span>{story.characters.length} characters</span>
                    {isAdmin && story.ownerName && story.userId !== currentUserId && (
                      <>
                        <span>·</span>
                        <span className="flex items-center gap-0.5">
                          <UserCircle size={10} />
                          {story.ownerName}
                        </span>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-1 mt-3 pt-3 border-t border-border">
                    {canEdit ? (
                      <>
                        <Button size="sm" variant="outline" onClick={() => { setEditingStory(story); setEditorOpen(true); }} className="flex-1">
                          <Edit2 size={12} /> Editar
                        </Button>
                        <button
                          onClick={() => { if (confirm(`¿Eliminar "${story.name}"?`)) remove.mutate(story.id); }}
                          className="p-1.5 rounded-lg hover:bg-red-500/10 text-text-muted hover:text-red-400 transition-colors"
                          title="Eliminar"
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    ) : (
                      <p className="text-[11px] text-text-muted italic flex-1">
                        Asignado por el administrador
                      </p>
                    )}
                    <button
                      onClick={() => setPreviewStory(story)}
                      className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
                      title="Ver descripción completa"
                    >
                      <Eye size={13} />
                    </button>
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      <StoryEditor key={editingStory?.id ?? 'new'} open={editorOpen} story={editingStory} onClose={() => setEditorOpen(false)} />

      {/* Story preview modal */}
      <Modal
        open={!!previewStory}
        onClose={() => setPreviewStory(null)}
        title={previewStory?.name ?? ''}
        size="lg"
      >
        {previewStory && (
          <div className="space-y-5 text-sm">
            {/* Description */}
            {previewStory.description && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-2">Descripción</p>
                <p className="text-text-primary leading-relaxed whitespace-pre-wrap">{previewStory.description}</p>
              </div>
            )}

            {/* Global context */}
            {previewStory.globalContext && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-2">Contexto global</p>
                <p className="text-text-primary leading-relaxed whitespace-pre-wrap">{previewStory.globalContext}</p>
              </div>
            )}

            {/* World lore */}
            {previewStory.worldLore && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-2">Lore del mundo</p>
                <p className="text-text-primary leading-relaxed whitespace-pre-wrap">{previewStory.worldLore}</p>
              </div>
            )}

            {/* Narrative rules */}
            {previewStory.narrativeRules && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-2">Reglas narrativas</p>
                <p className="text-text-primary leading-relaxed whitespace-pre-wrap">{previewStory.narrativeRules}</p>
              </div>
            )}

            {/* Stats row */}
            <div className="flex items-center gap-4 pt-2 border-t border-border text-[11px] text-text-muted">
              <span>{previewStory.persistentEvents.length} eventos</span>
              <span>·</span>
              <span>{Object.keys(previewStory.stateVariables).length} variables</span>
              <span>·</span>
              <span>{previewStory.characters.length} personajes vinculados</span>
              {previewStory.ownerName && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <UserCircle size={10} />
                    {previewStory.ownerName}
                  </span>
                </>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

