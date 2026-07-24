import { useState, useMemo } from 'react';
import {
  X, GitBranch, Trash2, Check, Pencil, CircleCheck, RotateCcw, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { threadsApi } from '../../api/threads.ts';
import type { NarrativeThread } from '@rpgspeak/shared';

/** Tope de hilos que el context-builder inyecta en el prompt (THREADS_MAX_INJECTED).
 *  Se replica aquí para poder marcar en la lista cuáles llegan de verdad al modelo:
 *  sin esa marca, un hilo importante empujado fuera del tope por otros cinco es
 *  indistinguible de uno que sí está influyendo en la narración. */
const MAX_INJECTED = 6;

interface ThreadsModalProps {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  messageCount: number;
}

interface EditState {
  title: string;
  description: string;
  importance: number;
}

export function ThreadsModal({ open, onClose, conversationId, messageCount }: ThreadsModalProps) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const { data: threads = [], isLoading } = useQuery({
    queryKey: ['threads', conversationId],
    queryFn: () => threadsApi.list(conversationId),
    enabled: open && !!conversationId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['threads', conversationId] });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof threadsApi.update>[1] }) =>
      threadsApi.update(id, data),
    onSuccess: () => { invalidate(); cancelEdit(); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => threadsApi.delete(id),
    onSuccess: () => { invalidate(); setConfirmDelete(null); },
  });

  // Mismo orden que `findOpen` en el repositorio: importancia desc, y a igual
  // importancia los más antiguos primero. Debe coincidir para que el corte de
  // los 6 primeros que se marca abajo sea el mismo corte que aplica el prompt.
  const open_ = useMemo(
    () => threads
      .filter((t) => t.status === 'open')
      .sort((a, b) => b.importance - a.importance || a.createdAt.localeCompare(b.createdAt)),
    [threads],
  );
  const closed = useMemo(
    () => threads
      .filter((t) => t.status === 'closed')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [threads],
  );

  const visible = tab === 'open' ? open_ : closed;

  function startEdit(t: NarrativeThread) {
    setConfirmDelete(null);
    setEditingId(t.id);
    setEditState({ title: t.title, description: t.description, importance: t.importance });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditState(null);
  }

  function saveEdit(id: string) {
    if (!editState?.title.trim()) return;
    updateMut.mutate({
      id,
      data: {
        title:       editState.title.trim(),
        description: editState.description.trim(),
        importance:  Math.min(10, Math.max(1, editState.importance)),
      },
    });
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
            <GitBranch size={15} className="text-accent" />
            <h2 className="font-semibold text-sm">Hilos narrativos</h2>
            {open_.length > 0 && (
              <span className="text-[11px] text-text-muted bg-white/5 px-2 py-0.5 rounded-full">
                {open_.length} abierto{open_.length !== 1 ? 's' : ''}
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

        {/* ── Tabs ───────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-border flex-shrink-0 bg-black/10">
          {([['open', 'Abiertos', open_.length], ['closed', 'Cerrados', closed.length]] as const).map(
            ([key, label, count]) => {
              const active = tab === key;
              return (
                <button
                  key={key}
                  onClick={() => { setTab(key); cancelEdit(); setConfirmDelete(null); }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                    active ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-primary hover:bg-white/5'
                  }`}
                >
                  <span>{label}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                      active ? 'bg-accent/25 text-accent' : 'bg-white/5 text-text-muted'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            },
          )}
        </div>

        {/* ── List ───────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2 min-h-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-text-muted text-xs">
              <RefreshCw size={14} className="animate-spin mr-2" />
              Cargando...
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-text-muted">
              <GitBranch size={32} className="mb-3 opacity-15" />
              <p className="text-sm font-medium">
                {tab === 'open' ? 'No hay hilos abiertos' : 'No hay hilos cerrados'}
              </p>
              <p className="text-xs mt-1 opacity-70 text-center max-w-xs">
                {tab === 'open'
                  ? 'La IA abre hilos sola cuando la historia deja algo pendiente.'
                  : 'Aquí aparecerán los hilos que se resuelvan.'}
              </p>
            </div>
          ) : (
            visible.map((t, i) => (
              <ThreadCard
                key={t.id}
                thread={t}
                messageCount={messageCount}
                injected={tab === 'open' && i < MAX_INJECTED}
                isEditing={editingId === t.id}
                editState={editingId === t.id ? editState : null}
                onEditState={setEditState}
                onStartEdit={() => startEdit(t)}
                onCancelEdit={cancelEdit}
                onSaveEdit={() => saveEdit(t.id)}
                saving={updateMut.isPending}
                onToggleStatus={() =>
                  updateMut.mutate({ id: t.id, data: { status: t.status === 'open' ? 'closed' : 'open' } })
                }
                confirmingDelete={confirmDelete === t.id}
                onAskDelete={() => { cancelEdit(); setConfirmDelete(t.id); }}
                onCancelDelete={() => setConfirmDelete(null)}
                onConfirmDelete={() => deleteMut.mutate(t.id)}
                deleting={deleteMut.isPending}
              />
            ))
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div className="flex-shrink-0 border-t border-border px-5 py-3">
          <p className="text-[11px] text-text-muted leading-relaxed">
            {tab === 'open' ? (
              <>
                La IA recibe los <span className="text-text-secondary">{MAX_INJECTED} hilos más importantes</span>
                {open_.length > MAX_INJECTED && (
                  open_.length - MAX_INJECTED === 1
                    ? <> — el restante no llega al prompt</>
                    : <> — los {open_.length - MAX_INJECTED} restantes no llegan al prompt</>
                )}
                . Sube la importancia de un hilo para que entre, o ciérralo si ya se resolvió.
              </>
            ) : (
              <>Un hilo cerrado deja de enviarse a la IA. Reábrelo si el asunto sigue vivo.</>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Thread card ──────────────────────────────────────────────────────────────

interface ThreadCardProps {
  thread: NarrativeThread;
  messageCount: number;
  injected: boolean;
  isEditing: boolean;
  editState: EditState | null;
  onEditState: (s: EditState) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  saving: boolean;
  onToggleStatus: () => void;
  confirmingDelete: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  deleting: boolean;
}

const inputCls =
  'w-full rounded-lg px-2.5 py-1.5 text-xs border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';

function ThreadCard({
  thread, messageCount, injected, isEditing, editState, onEditState,
  onStartEdit, onCancelEdit, onSaveEdit, saving, onToggleStatus,
  confirmingDelete, onAskDelete, onCancelDelete, onConfirmDelete, deleting,
}: ThreadCardProps) {
  const isOpen = thread.status === 'open';
  const age    = Math.max(0, messageCount - thread.openedAtIndex);
  // Mismos umbrales que buildThreadsBlock, para que lo que ve el usuario coincida
  // con la señal de urgencia que realmente recibe el modelo.
  const stale  = isOpen && age >= 60;
  const aging  = isOpen && age >= 25 && age < 60;

  if (isEditing && editState) {
    return (
      <div className="p-3 rounded-xl border border-accent/30 bg-accent/5 space-y-2">
        <input
          autoFocus
          value={editState.title}
          onChange={(e) => onEditState({ ...editState, title: e.target.value })}
          placeholder="Título del hilo"
          className={inputCls}
          style={{ background: 'var(--surface-2)' }}
        />
        <textarea
          value={editState.description}
          onChange={(e) => onEditState({ ...editState, description: e.target.value })}
          placeholder="Qué queda pendiente, en una frase"
          rows={2}
          className={`${inputCls} resize-none`}
          style={{ background: 'var(--surface-2)' }}
        />
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-text-muted">Importancia</span>
            <input
              type="number"
              min={1}
              max={10}
              value={editState.importance}
              onChange={(e) => onEditState({ ...editState, importance: Number(e.target.value) })}
              className="w-14 rounded-lg px-2 py-1.5 text-xs border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent text-center"
              style={{ background: 'var(--surface-2)' }}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onCancelEdit}
              className="px-3 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={onSaveEdit}
              disabled={!editState.title.trim() || saving}
              className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-40 transition-colors"
            >
              <Check size={11} />
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`group p-3 rounded-xl border transition-colors hover:bg-white/3 ${
        stale
          ? 'border-amber-400/30 bg-amber-400/5'
          : isOpen
            ? 'border-border bg-white/3'
            : 'border-border bg-black/10'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p
          className={`text-sm font-medium leading-tight ${
            isOpen ? 'text-text-primary' : 'text-text-muted line-through decoration-1'
          }`}
        >
          {thread.title}
        </p>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <ImportanceDots value={thread.importance} active={isOpen} />
          <button
            onClick={onStartEdit}
            title="Editar"
            className="p-1 rounded hover:bg-white/10 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-all"
          >
            <Pencil size={10} />
          </button>
          <button
            onClick={onToggleStatus}
            title={isOpen ? 'Marcar como resuelto' : 'Reabrir el hilo'}
            className={`p-1 rounded opacity-0 group-hover:opacity-100 transition-all ${
              isOpen
                ? 'hover:bg-emerald-500/15 text-text-muted hover:text-emerald-400'
                : 'hover:bg-accent/15 text-text-muted hover:text-accent'
            }`}
          >
            {isOpen ? <CircleCheck size={10} /> : <RotateCcw size={10} />}
          </button>
          <button
            onClick={onAskDelete}
            title="Borrar"
            className="p-1 rounded hover:bg-red-500/15 text-text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>

      {thread.description && (
        <p
          className={`text-[11px] leading-relaxed mt-0.5 ${
            isOpen ? 'text-text-secondary' : 'text-text-muted opacity-70'
          }`}
        >
          {thread.description}
        </p>
      )}

      <div className="flex items-center gap-2 mt-1.5">
        {isOpen ? (
          <>
            {stale && (
              <span className="flex items-center gap-1 text-[10px] text-amber-400 font-medium">
                <AlertTriangle size={9} />
                Sin resolver desde hace {age} mensajes
              </span>
            )}
            {aging && (
              <span className="text-[10px] text-text-muted opacity-70">
                Abierto hace {age} mensajes
              </span>
            )}
            {!stale && !aging && (
              <span className="text-[10px] text-text-muted opacity-60">
                Abierto en el mensaje {thread.openedAtIndex + 1}
              </span>
            )}
            {!injected && (
              <span
                className="text-[10px] text-text-muted opacity-70 px-1.5 py-0.5 rounded bg-white/5"
                title={`Solo los ${MAX_INJECTED} hilos más importantes se envían a la IA`}
              >
                fuera del prompt
              </span>
            )}
          </>
        ) : (
          <span className="text-[10px] text-text-muted opacity-60">
            Cerrado{thread.closedAtIndex !== null ? ` en el mensaje ${thread.closedAtIndex}` : ''}
          </span>
        )}
      </div>

      {confirmingDelete && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border text-[11px] text-text-muted">
          ¿Borrar este hilo?
          <button
            onClick={onConfirmDelete}
            disabled={deleting}
            className="px-2 py-0.5 rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20 transition-colors disabled:opacity-40"
          >
            {deleting ? 'Borrando…' : 'Confirmar'}
          </button>
          <button
            onClick={onCancelDelete}
            className="px-2 py-0.5 rounded-lg hover:bg-white/8 text-text-muted transition-colors"
          >
            Cancelar
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Importance dots (5 dots, each = 2 importance points) ────────────────────

function ImportanceDots({ value, active }: { value: number; active: boolean }) {
  const filled = Math.round(value / 2);
  return (
    <div className="flex items-center gap-0.5" title={`Importancia ${value}/10`}>
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          className={`w-1.5 h-1.5 rounded-full ${
            i < filled ? (active ? 'bg-accent' : 'bg-white/25') : 'bg-white/10'
          }`}
        />
      ))}
    </div>
  );
}
