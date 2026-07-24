import { useState } from 'react';
import { X, StickyNote, Trash2, Check, Pencil, ChevronUp, ChevronDown, Plus } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notesApi } from '../../api/notes.ts';
import type { ConversationNote } from '@rpgspeak/shared';

interface NotesModalProps {
  open: boolean;
  onClose: () => void;
  conversationId: string;
}

export function NotesModal({ open, onClose, conversationId }: NotesModalProps) {
  const qc = useQueryClient();
  const [newContent, setNewContent] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const { data: notes = [], isLoading } = useQuery({
    queryKey: ['notes', conversationId],
    queryFn: () => notesApi.list(conversationId),
    enabled: open && !!conversationId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['notes', conversationId] });

  const createMut = useMutation({
    mutationFn: (content: string) => notesApi.create(conversationId, content),
    onSuccess: () => { invalidate(); setNewContent(''); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => notesApi.update(id, content),
    onSuccess: () => { invalidate(); setEditingId(null); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => notesApi.delete(id),
    onSuccess: () => { invalidate(); setConfirmDelete(null); },
  });

  const reorderMut = useMutation({
    mutationFn: (orderedIds: string[]) => notesApi.reorder(conversationId, orderedIds),
    onSuccess: () => invalidate(),
  });

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= notes.length) return;
    const reordered = [...notes];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    reorderMut.mutate(reordered.map((n) => n.id));
  }

  function startEdit(n: ConversationNote) {
    setConfirmDelete(null);
    setEditingId(n.id);
    setEditContent(n.content);
  }

  function saveEdit(id: string) {
    if (!editContent.trim()) return;
    updateMut.mutate({ id, content: editContent.trim() });
  }

  function handleCreate() {
    const trimmed = newContent.trim();
    if (!trimmed) return;
    createMut.mutate(trimmed);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55" onClick={onClose} />

      <div
        className="relative w-full max-w-2xl max-h-[84vh] rounded-2xl border border-border shadow-2xl animate-fade-in flex flex-col"
        style={{ background: 'var(--surface-1)' }}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <StickyNote size={15} className="text-accent" />
            <h2 className="font-semibold text-sm">Notas de coherencia</h2>
            {notes.length > 0 && (
              <span className="text-[11px] text-text-muted bg-white/5 px-2 py-0.5 rounded-full">
                {notes.length}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* ── Add note ───────────────────────────────────────────────────── */}
        <div className="px-5 py-3 border-b border-border flex-shrink-0 bg-black/10">
          <div className="flex items-start gap-2">
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCreate(); }
              }}
              placeholder="Añade un hecho fijo que la IA debe respetar siempre…"
              rows={2}
              className="flex-1 rounded-lg px-2.5 py-1.5 text-xs border border-border text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:ring-1 focus:ring-accent"
              style={{ background: 'var(--surface-2)' }}
            />
            <button
              onClick={handleCreate}
              disabled={!newContent.trim() || createMut.isPending}
              className="flex items-center gap-1 px-3 py-2 text-xs rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-40 transition-colors flex-shrink-0"
            >
              <Plus size={12} />
              Añadir
            </button>
          </div>
        </div>

        {/* ── List ───────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2 min-h-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-text-muted text-xs">Cargando...</div>
          ) : notes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-text-muted">
              <StickyNote size={32} className="mb-3 opacity-15" />
              <p className="text-sm font-medium">No hay notas todavía</p>
              <p className="text-xs mt-1 opacity-70 text-center max-w-xs">
                Añade hechos que quieras que la IA respete siempre — nombres, reglas del mundo, decisiones ya tomadas.
              </p>
            </div>
          ) : (
            notes.map((n, i) => (
              <div
                key={n.id}
                className="group p-3 rounded-xl border border-border bg-white/3 hover:bg-white/5 transition-colors"
              >
                {editingId === n.id ? (
                  <div className="space-y-2">
                    <textarea
                      autoFocus
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={2}
                      className="w-full rounded-lg px-2.5 py-1.5 text-xs border border-border text-text-primary resize-none focus:outline-none focus:ring-1 focus:ring-accent"
                      style={{ background: 'var(--surface-2)' }}
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setEditingId(null)}
                        className="px-3 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
                      >
                        Cancelar
                      </button>
                      <button
                        onClick={() => saveEdit(n.id)}
                        disabled={!editContent.trim() || updateMut.isPending}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-40 transition-colors"
                      >
                        <Check size={11} />
                        {updateMut.isPending ? 'Guardando…' : 'Guardar'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-text-primary leading-snug flex-1">{n.content}</p>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => move(i, -1)}
                        disabled={i === 0}
                        title="Subir"
                        className="p-1 rounded hover:bg-white/10 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 disabled:opacity-0 transition-all"
                      >
                        <ChevronUp size={12} />
                      </button>
                      <button
                        onClick={() => move(i, 1)}
                        disabled={i === notes.length - 1}
                        title="Bajar"
                        className="p-1 rounded hover:bg-white/10 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 disabled:opacity-0 transition-all"
                      >
                        <ChevronDown size={12} />
                      </button>
                      <button
                        onClick={() => startEdit(n)}
                        title="Editar"
                        className="p-1 rounded hover:bg-white/10 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <Pencil size={11} />
                      </button>
                      {confirmDelete === n.id ? (
                        <>
                          <button
                            onClick={() => deleteMut.mutate(n.id)}
                            disabled={deleteMut.isPending}
                            className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20 transition-colors"
                          >
                            Confirmar
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            className="px-1.5 py-0.5 rounded text-[10px] text-text-muted hover:text-text-primary transition-colors"
                          >
                            Cancelar
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(n.id)}
                          title="Borrar"
                          className="p-1 rounded hover:bg-red-500/15 text-text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div className="flex-shrink-0 border-t border-border px-5 py-3">
          <p className="text-[11px] text-text-muted leading-relaxed">
            Estas notas se envían SIEMPRE a la IA, en este orden, justo antes de tu mensaje — trátalas como hechos
            fijos, no como sugerencias que la IA pueda ignorar.
          </p>
        </div>
      </div>
    </div>
  );
}
