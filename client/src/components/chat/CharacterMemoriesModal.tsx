import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { memoriesApi } from '../../api/memories.ts';
import type { MemoryEntry } from '@rpgspeak/shared';
import {
  X, Zap, Info, Heart, Star, Brain, Trash2, Plus, ShieldAlert, Skull, Pencil, Check,
} from 'lucide-react';

const TYPE_META: Record<MemoryEntry['type'], { label: string; Icon: React.ElementType; color: string }> = {
  event:        { label: 'Evento',      Icon: Zap,         color: 'text-amber-400' },
  fact:         { label: 'Hecho',       Icon: Info,        color: 'text-blue-400' },
  relationship: { label: 'Relación',    Icon: Heart,       color: 'text-rose-400' },
  preference:   { label: 'Preferencia', Icon: Star,        color: 'text-violet-400' },
  summary:      { label: 'Resumen',     Icon: Brain,       color: 'text-text-muted' },
  offense:      { label: 'Ofensa',      Icon: ShieldAlert, color: 'text-orange-400' },
  trauma:       { label: 'Trauma',      Icon: Skull,       color: 'text-red-400' },
};

interface Props {
  characterId: string;
  characterName: string;
  conversationId: string;
  onClose: () => void;
}

/** Estado de edición inline de una memoria */
interface EditState {
  content: string;
  type: MemoryEntry['type'];
  importance: number;
}

const inputCls = 'w-full rounded-lg px-3 py-2 text-sm border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent';

export function CharacterMemoriesModal({ characterId, characterName, conversationId, onClose }: Props) {
  const qc = useQueryClient();
  const [addOpen,      setAddOpen]      = useState(false);
  const [editingId,    setEditingId]    = useState<string | null>(null);
  const [editState,    setEditState]    = useState<EditState | null>(null);
  const [newContent,   setNewContent]   = useState('');
  const [newType,      setNewType]      = useState<MemoryEntry['type']>('event');
  const [newImportance, setNewImportance] = useState(5);

  const { data: memories = [], isLoading } = useQuery({
    queryKey: ['memories', conversationId, characterId],
    queryFn: () => memoriesApi.list(conversationId, characterId),
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => memoriesApi.deactivate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memories', conversationId, characterId] }),
  });

  const createMemory = useMutation({
    mutationFn: () => memoriesApi.create({
      conversationId,
      characterId,
      type:       newType,
      content:    newContent.trim(),
      importance: newImportance,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memories', conversationId, characterId] });
      setNewContent('');
      setNewImportance(5);
      setAddOpen(false);
    },
  });

  const updateMemory = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<EditState> }) =>
      memoriesApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memories', conversationId, characterId] });
      setEditingId(null);
      setEditState(null);
    },
  });

  function startEdit(m: MemoryEntry) {
    setEditingId(m.id);
    setEditState({ content: m.content, type: m.type, importance: m.importance });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditState(null);
  }

  function saveEdit(id: string) {
    if (!editState) return;
    updateMemory.mutate({ id, data: editState });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.72)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border flex flex-col max-h-[80vh] animate-slide-up"
        style={{ background: 'var(--surface-1)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Brain size={15} className="text-accent" />
            <div>
              <p className="font-semibold text-sm">Memorias de <span className="text-accent">{characterName}</span></p>
              <p className="text-[10px] text-text-muted mt-0.5">
                Solo en esta conversación · {memories.length} {memories.length === 1 ? 'recuerdo' : 'recuerdos'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => { setAddOpen((v) => !v); setEditingId(null); }}
              title="Añadir recuerdo"
              className="p-1.5 rounded-lg hover:bg-accent/10 text-text-muted hover:text-accent transition-colors"
            >
              <Plus size={15} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* ── Add form ── */}
        {addOpen && (
          <div className="px-5 py-3 border-b border-border flex-shrink-0 space-y-2" style={{ background: 'var(--surface-2)' }}>
            <p className="text-xs font-semibold text-text-secondary">Añadir recuerdo manualmente</p>
            <textarea
              autoFocus
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              className={`${inputCls} resize-none`}
              style={{ background: 'var(--surface-2)' }}
              rows={2}
              placeholder="Describe el recuerdo desde la perspectiva del personaje…"
            />
            <div className="flex gap-2">
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as MemoryEntry['type'])}
                className={inputCls}
                style={{ background: 'var(--surface-2)', flex: 1 }}
              >
                {(Object.entries(TYPE_META) as [MemoryEntry['type'], typeof TYPE_META[keyof typeof TYPE_META]][]).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="text-xs text-text-muted">Imp.</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={newImportance}
                  onChange={(e) => setNewImportance(Number(e.target.value))}
                  className="w-14 rounded-lg px-2 py-2 text-sm bg-surface-2 border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent text-center"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setAddOpen(false)}
                className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={() => createMemory.mutate()}
                disabled={!newContent.trim() || createMemory.isPending}
                className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-40 transition-colors"
              >
                {createMemory.isPending ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        )}

        {/* ── Memory list ── */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && (
            <div className="py-8 text-center text-xs text-text-muted animate-pulse">Cargando memorias…</div>
          )}
          {!isLoading && memories.length === 0 && (
            <div className="py-10 text-center space-y-2">
              <Brain size={28} className="mx-auto text-text-muted/30" />
              <p className="text-sm text-text-muted">Sin memorias en esta conversación</p>
              <p className="text-xs text-text-muted/60">
                Activa el LLM Rápido en Ajustes para generarlas automáticamente.
              </p>
            </div>
          )}
          {!isLoading && memories.length > 0 && (
            <ul className="divide-y divide-border">
              {memories.map((m) => {
                const meta = TYPE_META[m.type] ?? TYPE_META.event;
                const { Icon } = meta;
                const isEditing = editingId === m.id;

                return (
                  <li key={m.id} className="px-5 py-3 hover:bg-white/3 transition-colors group">
                    {isEditing && editState ? (
                      /* ── Inline edit form ── */
                      <div className="space-y-2">
                        <textarea
                          autoFocus
                          value={editState.content}
                          onChange={(e) => setEditState({ ...editState, content: e.target.value })}
                          className={`${inputCls} resize-none`}
                          style={{ background: 'var(--surface-2)' }}
                          rows={3}
                        />
                        <div className="flex gap-2">
                          <select
                            value={editState.type}
                            onChange={(e) => setEditState({ ...editState, type: e.target.value as MemoryEntry['type'] })}
                            className={inputCls}
                            style={{ background: 'var(--surface-2)', flex: 1 }}
                          >
                            {(Object.entries(TYPE_META) as [MemoryEntry['type'], typeof TYPE_META[keyof typeof TYPE_META]][]).map(([k, v]) => (
                              <option key={k} value={k}>{v.label}</option>
                            ))}
                          </select>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <span className="text-xs text-text-muted">Imp.</span>
                            <input
                              type="number"
                              min={1}
                              max={10}
                              value={editState.importance}
                              onChange={(e) => setEditState({ ...editState, importance: Number(e.target.value) })}
                              className="w-14 rounded-lg px-2 py-2 text-sm border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent text-center"
                              style={{ background: 'var(--surface-2)' }}
                            />
                          </div>
                        </div>
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={cancelEdit}
                            className="px-3 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
                          >
                            Cancelar
                          </button>
                          <button
                            onClick={() => saveEdit(m.id)}
                            disabled={!editState.content.trim() || updateMemory.isPending}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-40 transition-colors"
                          >
                            <Check size={11} />
                            {updateMemory.isPending ? 'Guardando…' : 'Guardar'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* ── Read mode ── */
                      <div className="flex items-start gap-3">
                        <div className={`mt-0.5 flex-shrink-0 ${meta.color}`}>
                          <Icon size={13} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-text-primary leading-relaxed">{m.content}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <span className={`text-[9px] font-semibold uppercase tracking-wide ${meta.color}`}>{meta.label}</span>
                            <span className="text-[9px] text-text-muted">·</span>
                            <span className="text-[9px] text-text-muted">Imp. {m.importance}/10</span>
                            <span className="text-[9px] text-text-muted">·</span>
                            <span className="text-[9px] text-text-muted">{new Date(m.createdAt).toLocaleDateString('es')}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                          <button
                            onClick={() => startEdit(m)}
                            title="Editar recuerdo"
                            className="p-1 rounded hover:bg-accent/15 text-text-muted hover:text-accent transition-colors"
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            onClick={() => deactivate.mutate(m.id)}
                            disabled={deactivate.isPending}
                            title="Eliminar recuerdo"
                            className="p-1 rounded hover:bg-red-500/15 text-text-muted hover:text-red-400 transition-colors"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
