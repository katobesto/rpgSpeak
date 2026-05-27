import React, { useState, useMemo, useRef, useCallback } from 'react';
import {
  X, RefreshCw, Trash2, MapPin, User, Zap, BookOpen, ChevronRight, Square, AlertTriangle, Trophy, Sparkles,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { contextApi } from '../../api/context.ts';
import type { ContextItem, ContextItemType, Message } from '@rpgspeak/shared';

// ─── Type display config ──────────────────────────────────────────────────────

const TYPE_CFG = {
  event: {
    label: 'Eventos',
    singular: 'Evento',
    Icon: Zap,
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
    border: 'border-amber-400/20',
    dot: 'bg-amber-400',
  },
  character: {
    label: 'Personajes',
    singular: 'Personaje',
    Icon: User,
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
    border: 'border-blue-400/20',
    dot: 'bg-blue-400',
  },
  place: {
    label: 'Lugares',
    singular: 'Lugar',
    Icon: MapPin,
    color: 'text-emerald-400',
    bg: 'bg-emerald-400/10',
    border: 'border-emerald-400/20',
    dot: 'bg-emerald-400',
  },
  quest: {
    label: 'Conquistas',
    singular: 'Conquista',
    Icon: Trophy,
    color: 'text-violet-400',
    bg: 'bg-violet-400/10',
    border: 'border-violet-400/20',
    dot: 'bg-violet-400',
  },
} as const;

// ─── Props ────────────────────────────────────────────────────────────────────

interface ContextModalProps {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  messages: Message[];
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ContextModal({ open, onClose, conversationId, messages }: ContextModalProps) {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<ContextItemType | 'all'>('all');
  const [extracting, setExtracting] = useState(false);
  const [currentBatch, setCurrentBatch] = useState<number | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const stopRef = useRef(false);

  // Only non-system messages are indexed
  const indexable = useMemo(() => messages.filter((m) => m.role !== 'system'), [messages]);
  const totalMessages = indexable.length;

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['context', conversationId],
    queryFn: () => contextApi.list(conversationId),
    enabled: open && !!conversationId,
  });

  // How far the indexing has gone
  const processedUpTo = useMemo(
    () => (items.length === 0 ? 0 : Math.max(...items.map((i) => i.messageIndexTo))),
    [items]
  );
  const allProcessed = totalMessages > 0 && processedUpTo >= totalMessages;

  // Item counts per type
  const counts = useMemo(
    () => ({
      event:     items.filter((i) => i.type === 'event').length,
      character: items.filter((i) => i.type === 'character').length,
      place:     items.filter((i) => i.type === 'place').length,
      quest:     items.filter((i) => i.type === 'quest').length,
    }),
    [items]
  );

  // Filtered list
  const visible = useMemo(
    () =>
      (activeTab === 'all' ? items : items.filter((i) => i.type === activeTab))
        .slice()
        .sort((a, b) => b.importance - a.importance || b.messageIndexFrom - a.messageIndexFrom),
    [items, activeTab]
  );

  // Delete single
  const deleteMut = useMutation({
    mutationFn: (id: string) => contextApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['context', conversationId] }),
  });

  // Delete all items for this conversation
  const deleteAllMut = useMutation({
    mutationFn: () => contextApi.deleteAll(conversationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['context', conversationId] });
      setConfirmClear(false);
    },
  });

  // Compute embeddings for items without one
  const embedAllMut = useMutation({
    mutationFn: () => contextApi.embedAll(conversationId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['context', conversationId] }),
  });

  // Core extract call
  const runBatch = useCallback(
    async (batchStart: number) => {
      setCurrentBatch(batchStart);
      const result = await contextApi.extract(conversationId, batchStart);
      qc.invalidateQueries({ queryKey: ['context', conversationId] });
      return result;
    },
    [conversationId, qc]
  );

  function friendlyError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    // Context window exceeded — give an actionable hint
    if (/n_ctx|context.length|context_length|too long|tokens.*exceed|exceed.*token/i.test(msg)) {
      return `El modelo no tiene suficiente ventana de contexto para procesar ${currentBatch !== null ? 100 : 'el lote de'} mensajes a la vez.\n\n💡 Prueba con un modelo que tenga ≥ 8 k de contexto, o reduce los mensajes por lote editando el prompt en Ajustes → Generación.`;
    }
    // 404 / model not found
    if (/404|No endpoints found|model.*not.*found|not.*found.*model/i.test(msg)) {
      return `Modelo no disponible en el proveedor: ${msg.slice(0, 200)}`;
    }
    return msg.slice(0, 400);
  }

  async function handleNext() {
    setExtractError(null);
    setExtracting(true);
    stopRef.current = false;
    try {
      await runBatch(processedUpTo);
    } catch (err) {
      setExtractError(friendlyError(err));
    } finally {
      setExtracting(false);
      setCurrentBatch(null);
    }
  }

  async function handleAll() {
    setExtractError(null);
    setExtracting(true);
    stopRef.current = false;
    // If fully processed, restart from scratch
    let batchStart = allProcessed ? 0 : processedUpTo;
    try {
      while (!stopRef.current) {
        const result = await runBatch(batchStart);
        batchStart = result.batchEnd;
        if (result.batchEnd >= result.totalMessages || result.items.length === 0) break;
      }
    } catch (err) {
      setExtractError(friendlyError(err));
    } finally {
      setExtracting(false);
      setCurrentBatch(null);
    }
  }

  if (!open) return null;

  const progressPct = totalMessages > 0 ? Math.round((processedUpTo / totalMessages) * 100) : 0;
  const nextEnd     = Math.min(processedUpTo + 100, totalMessages);

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
            <BookOpen size={15} className="text-accent" />
            <h2 className="font-semibold text-sm">Índice de Contexto</h2>
            {items.length > 0 && (
              <span className="text-[11px] text-text-muted bg-white/5 px-2 py-0.5 rounded-full">
                {items.length} entrada{items.length !== 1 ? 's' : ''}
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

        {/* ── Type tabs ──────────────────────────────────────────────────── */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-border flex-shrink-0 bg-black/10">
          {(['all', 'event', 'character', 'place', 'quest'] as const).map((tab) => {
            const isAll = tab === 'all';
            const count = isAll ? items.length : counts[tab];
            const cfg   = !isAll ? TYPE_CFG[tab] : null;
            const Icon  = cfg?.Icon;
            const active = activeTab === tab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                  active
                    ? 'bg-accent/15 text-accent'
                    : 'text-text-muted hover:text-text-primary hover:bg-white/5'
                }`}
              >
                {Icon && <Icon size={11} className={active ? 'text-accent' : cfg!.color} />}
                <span>{isAll ? 'Todo' : cfg!.label}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                    active ? 'bg-accent/25 text-accent' : 'bg-white/5 text-text-muted'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── Item list ──────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2 min-h-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-text-muted text-xs">
              <RefreshCw size={14} className="animate-spin mr-2" />
              Cargando...
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-text-muted">
              <BookOpen size={32} className="mb-3 opacity-15" />
              <p className="text-sm font-medium">
                {items.length === 0 ? 'El índice está vacío' : 'Sin entradas en esta categoría'}
              </p>
              {items.length === 0 && (
                <p className="text-xs mt-1 opacity-70">
                  Usa "Extraer" abajo para analizar la conversación con IA
                </p>
              )}
            </div>
          ) : (
            visible.map((item) => (
              <ContextCard
                key={item.id}
                item={item}
                onDelete={() => deleteMut.mutate(item.id)}
              />
            ))
          )}
        </div>

        {/* ── Footer: extraction controls ────────────────────────────────── */}
        <div className="flex-shrink-0 border-t border-border px-5 py-4 space-y-3">
          {/* Progress bar */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-text-muted">
              <span>Mensajes indexados</span>
              <span>
                {processedUpTo} / {totalMessages}
                {allProcessed && (
                  <span className="ml-2 text-emerald-400 font-medium">✓ Completo</span>
                )}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-white/8 overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          {/* Error banner */}
          {extractError && (
            <div className="flex gap-2.5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-medium mb-0.5">Error en la extracción</p>
                <p className="whitespace-pre-wrap leading-relaxed opacity-90">{extractError}</p>
              </div>
              <button
                onClick={() => setExtractError(null)}
                className="flex-shrink-0 p-0.5 hover:opacity-70 transition-opacity"
              >
                <X size={12} />
              </button>
            </div>
          )}

          {/* Buttons row */}
          <div className="flex items-center gap-2">
            {extracting && currentBatch !== null && (
              <span className="text-xs text-text-muted flex items-center gap-1.5 flex-1">
                <RefreshCw size={11} className="animate-spin flex-shrink-0" />
                Procesando mensajes {currentBatch + 1}–{Math.min(currentBatch + 100, totalMessages)}…
              </span>
            )}

            {/* Confirm-clear inline panel */}
            {confirmClear && !extracting && (
              <span className="text-xs text-text-muted flex items-center gap-2 flex-1">
                ¿Borrar todo el índice?
                <button
                  onClick={() => deleteAllMut.mutate()}
                  disabled={deleteAllMut.isPending}
                  className="px-2 py-0.5 rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20 transition-colors"
                >
                  {deleteAllMut.isPending ? 'Borrando…' : 'Confirmar'}
                </button>
                <button
                  onClick={() => setConfirmClear(false)}
                  className="px-2 py-0.5 rounded-lg hover:bg-white/8 text-text-muted transition-colors"
                >
                  Cancelar
                </button>
              </span>
            )}

            <div className="flex-1" />

            {extracting ? (
              <button
                onClick={() => { stopRef.current = true; }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors"
              >
                <Square size={10} />
                Detener
              </button>
            ) : (
              <>
                {/* Compute embeddings */}
                {items.length > 0 && !confirmClear && (
                  <button
                    onClick={() => embedAllMut.mutate()}
                    disabled={embedAllMut.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-white/5 hover:bg-violet-500/10 text-text-muted hover:text-violet-400 border border-border hover:border-violet-500/20 transition-colors disabled:opacity-40"
                    title="Calcular embeddings semánticos para ítems sin vectorizar"
                  >
                    <Sparkles size={11} />
                    {embedAllMut.isPending ? 'Calculando…' : 'Embeddings'}
                  </button>
                )}

                {/* Clear all */}
                {items.length > 0 && !confirmClear && (
                  <button
                    onClick={() => setConfirmClear(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-white/5 hover:bg-red-500/10 text-text-muted hover:text-red-400 border border-border hover:border-red-500/20 transition-colors"
                    title="Borrar todo el índice de esta conversación"
                  >
                    <Trash2 size={11} />
                    Borrar todo
                  </button>
                )}

                {!allProcessed && totalMessages > 0 && (
                  <button
                    onClick={handleNext}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-white/5 hover:bg-white/10 text-text-secondary hover:text-text-primary border border-border transition-colors"
                    title={`Analizar mensajes ${processedUpTo + 1}–${nextEnd}`}
                  >
                    <ChevronRight size={11} />
                    Lote {processedUpTo + 1}–{nextEnd}
                  </button>
                )}
                <button
                  onClick={handleAll}
                  disabled={totalMessages === 0}
                  className="flex items-center gap-2 px-4 py-1.5 rounded-xl text-xs bg-accent text-white hover:bg-accent-hover disabled:opacity-40 transition-colors"
                >
                  <RefreshCw size={11} />
                  {allProcessed ? 'Reindexar todo' : 'Procesar todo'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Item card ────────────────────────────────────────────────────────────────

function ContextCard({ item, onDelete }: { item: ContextItem; onDelete: () => void }) {
  const cfg  = TYPE_CFG[item.type];
  const Icon = cfg.Icon;

  return (
    <div
      className={`group flex gap-3 p-3 rounded-xl border transition-colors hover:bg-white/3 ${cfg.border} ${cfg.bg}`}
    >
      {/* Icon */}
      <div className={`flex-shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center rounded-lg bg-black/20`}>
        <Icon size={13} className={cfg.color} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-text-primary leading-tight">{item.title}</p>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <ImportanceDots value={item.importance} dotClass={cfg.dot} />
            <button
              onClick={onDelete}
              className="p-1 rounded hover:bg-red-500/15 text-text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
            >
              <Trash2 size={10} />
            </button>
          </div>
        </div>

        {item.description && (
          <p className="text-[11px] text-text-secondary leading-relaxed mt-0.5">
            {item.description}
          </p>
        )}

        <p className="text-[10px] text-text-muted mt-1 opacity-60">
          msgs {item.messageIndexFrom + 1}–{item.messageIndexTo}
        </p>
      </div>
    </div>
  );
}

// ─── Importance dots (5 dots, each = 2 importance points) ────────────────────

function ImportanceDots({ value, dotClass }: { value: number; dotClass: string }) {
  const filled = Math.round(value / 2);
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          className={`w-1.5 h-1.5 rounded-full ${i < filled ? dotClass : 'bg-white/10'}`}
        />
      ))}
    </div>
  );
}
