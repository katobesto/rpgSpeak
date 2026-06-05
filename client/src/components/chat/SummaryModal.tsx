import React, { useState, createPortal } from 'react';
import {
  X, RefreshCw, Trash2, Clock, BookOpen, Plus, ChevronDown, ChevronUp,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { summariesApi } from '../../api/summaries.ts';
import type { ConversationSummary } from '@rpgspeak/shared';

interface SummaryModalProps {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  messageCount: number;
}

type Tab = 'history' | 'generate';

function SummaryCard({
  summary,
  onDelete,
  deleting,
}: {
  summary: ConversationSummary;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = summary.content.length > 220;
  const displayed = isLong && !expanded ? summary.content.slice(0, 220) + '…' : summary.content;
  const date = new Date(summary.createdAt).toLocaleDateString('es', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  return (
    <div
      className="rounded-xl border border-border p-4 space-y-2 transition-colors"
      style={{ background: 'var(--surface-2)' }}
    >
      {/* Meta */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Clock size={11} className="text-text-muted flex-shrink-0" />
          <span className="text-[10px] text-text-muted truncate">{date}</span>
          <span className="text-[10px] text-text-muted/60">·</span>
          <span className="text-[10px] text-accent/80 font-medium">
            Msgs {summary.messageIndexFrom + 1}–{summary.messageIndexTo + 1}
          </span>
        </div>
        <button
          onClick={onDelete}
          disabled={deleting}
          title="Eliminar resumen"
          className="p-1 rounded-lg hover:bg-red-500/15 text-text-muted hover:text-red-400 transition-colors flex-shrink-0 disabled:opacity-40"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Content */}
      <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
        {displayed}
      </p>

      {/* Expand toggle */}
      {isLong && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-accent/70 hover:text-accent transition-colors"
        >
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          {expanded ? 'Mostrar menos' : 'Mostrar más'}
        </button>
      )}
    </div>
  );
}

export function SummaryModal({
  open,
  onClose,
  conversationId,
  messageCount,
}: SummaryModalProps) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('history');
  const [fromMsg, setFromMsg] = useState(1);
  const [toMsg,   setToMsg]   = useState(Math.max(1, messageCount));

  const { data: summaries = [], isLoading } = useQuery({
    queryKey: ['summaries', conversationId],
    queryFn: () => summariesApi.list(conversationId),
    enabled:  open,
  });

  const generateMut = useMutation({
    mutationFn: () => summariesApi.generate({
      conversationId,
      messageIndexFrom: fromMsg - 1,
      messageIndexTo:   toMsg - 1,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['summaries', conversationId] });
      setTab('history');
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => summariesApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['summaries', conversationId] }),
  });

  // Presets
  function applyPreset(last: number) {
    const to = messageCount;
    const from = Math.max(1, to - last + 1);
    setFromMsg(from);
    setToMsg(to);
  }

  if (!open) return null;

  const modal = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55" onClick={onClose} />

      <div
        className="relative w-full max-w-xl mx-auto rounded-2xl border border-border shadow-2xl flex flex-col max-h-[85vh] animate-fade-in"
        style={{ background: 'var(--surface-1)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <BookOpen size={14} className="text-accent" />
            <h2 className="font-semibold text-sm">Resumen de sucesos</h2>
            <span className="text-[10px] text-text-muted">
              ({summaries.length} {summaries.length === 1 ? 'entrada' : 'entradas'})
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Tabs */}
        <div
          className="flex border-b border-border flex-shrink-0 px-5"
          style={{ background: 'var(--surface-1)' }}
        >
          {(['history', 'generate'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`py-2.5 px-3 text-xs font-medium border-b-2 transition-colors -mb-px ${
                tab === t
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-muted hover:text-text-secondary'
              }`}
            >
              {t === 'history' ? 'Historial' : 'Generar nuevo'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">

          {/* ── Historial ── */}
          {tab === 'history' && (
            <div className="p-4 space-y-3">
              {isLoading && (
                <p className="text-xs text-text-muted text-center py-6 animate-pulse">Cargando historial…</p>
              )}
              {!isLoading && summaries.length === 0 && (
                <div className="py-10 text-center space-y-2">
                  <BookOpen size={28} className="mx-auto text-text-muted/30" />
                  <p className="text-sm text-text-muted">No hay resúmenes generados</p>
                  <p className="text-xs text-text-muted/60">
                    Usa la pestaña <em>Generar nuevo</em> para crear el primero.
                  </p>
                </div>
              )}
              {!isLoading && summaries.map((s) => (
                <SummaryCard
                  key={s.id}
                  summary={s}
                  onDelete={() => deleteMut.mutate(s.id)}
                  deleting={deleteMut.isPending && deleteMut.variables === s.id}
                />
              ))}
            </div>
          )}

          {/* ── Generar ── */}
          {tab === 'generate' && (
            <div className="p-5 space-y-5">
              {/* Presets */}
              <div>
                <p className="text-xs text-text-muted mb-2">Acceso rápido</p>
                <div className="flex flex-wrap gap-2">
                  {[10, 20, 30, 50].map((n) => (
                    <button
                      key={n}
                      onClick={() => applyPreset(n)}
                      className="px-3 py-1.5 rounded-lg text-xs border border-border hover:border-accent hover:text-accent transition-colors"
                    >
                      Últimos {n}
                    </button>
                  ))}
                  <button
                    onClick={() => { setFromMsg(1); setToMsg(messageCount); }}
                    className="px-3 py-1.5 rounded-lg text-xs border border-border hover:border-accent hover:text-accent transition-colors"
                  >
                    Todo ({messageCount} msgs)
                  </button>
                </div>
              </div>

              {/* Range inputs */}
              <div>
                <p className="text-xs text-text-muted mb-2">Rango de mensajes</p>
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <label className="block text-[10px] text-text-muted mb-1">Desde</label>
                    <input
                      type="number"
                      min={1}
                      max={toMsg}
                      value={fromMsg}
                      onChange={(e) => setFromMsg(Math.max(1, Math.min(toMsg, Number(e.target.value))))}
                      className="w-full rounded-lg px-3 py-2 text-sm border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                      style={{ background: 'var(--surface-2)' }}
                    />
                  </div>
                  <span className="text-text-muted mt-4">–</span>
                  <div className="flex-1">
                    <label className="block text-[10px] text-text-muted mb-1">Hasta</label>
                    <input
                      type="number"
                      min={fromMsg}
                      max={messageCount}
                      value={toMsg}
                      onChange={(e) => setToMsg(Math.max(fromMsg, Math.min(messageCount, Number(e.target.value))))}
                      className="w-full rounded-lg px-3 py-2 text-sm border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                      style={{ background: 'var(--surface-2)' }}
                    />
                  </div>
                </div>
                <p className="text-[10px] text-text-muted mt-1.5">
                  Total conversación: {messageCount} mensajes
                </p>
              </div>

              {/* Error */}
              {generateMut.isError && (
                <p className="text-xs text-red-400 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
                  {(generateMut.error as Error).message}
                </p>
              )}

              {/* Generate button */}
              <button
                onClick={() => generateMut.mutate()}
                disabled={generateMut.isPending || fromMsg > toMsg}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors font-medium"
              >
                <RefreshCw size={13} className={generateMut.isPending ? 'animate-spin' : ''} />
                {generateMut.isPending
                  ? 'Generando…'
                  : `Generar resumen (msgs ${fromMsg}–${toMsg})`}
              </button>

              <p className="text-[11px] text-text-muted leading-relaxed">
                La longitud máxima del resumen se controla en{' '}
                <span className="text-text-secondary">Ajustes → Generación → Longitud de resúmenes</span>.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        {tab === 'history' && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border flex-shrink-0">
            <span className="text-[11px] text-text-muted">
              {summaries.length > 0 ? `${summaries.length} ${summaries.length === 1 ? 'resumen guardado' : 'resúmenes guardados'}` : 'Sin entradas'}
            </span>
            <button
              onClick={() => setTab('generate')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
            >
              <Plus size={11} />
              Nuevo resumen
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
