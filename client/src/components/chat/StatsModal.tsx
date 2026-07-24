import React from 'react';
import { X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { charactersApi } from '../../api/characters.ts';
import { storiesApi } from '../../api/stories.ts';
import { BG_LABEL_NAMES } from '../../lib/bg-labels.ts';
import type { Conversation, Message } from '@rpgspeak/shared';

interface StatsModalProps {
  open: boolean;
  onClose: () => void;
  conversation: Conversation;
  messages?: Message[];
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString('es-ES', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('es-ES');
}

export function StatsModal({ open, onClose, conversation, messages = [] }: StatsModalProps) {
  const { data: allCharacters = [] } = useQuery({
    queryKey: ['characters'],
    queryFn: () => charactersApi.list(),
    enabled: open,
  });

  const { data: allStories = [] } = useQuery({
    queryKey: ['stories'],
    queryFn: () => storiesApi.list(),
    enabled: open,
  });

  if (!open) return null;

  const charIds = conversation.characters.map((c) => c.characterId);
  const charNames = allCharacters
    .filter((c) => charIds.includes(c.id))
    .map((c) => c.name);

  const storyIds = conversation.stories.map((s) => s.storyId);
  const storyNames = allStories
    .filter((s) => storyIds.includes(s.id))
    .map((s) => s.name);

  // Aggregate per-message token data
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCached = 0;
  for (const msg of messages) {
    if (msg.metadata?.promptTokens)    totalPrompt    += msg.metadata.promptTokens as number;
    if (msg.metadata?.completionTokens) totalCompletion += msg.metadata.completionTokens as number;
    if (msg.metadata?.cachedTokens)    totalCached    += msg.metadata.cachedTokens as number;
  }
  const hasTokenBreakdown = totalPrompt > 0 || totalCompletion > 0;
  const cacheEfficiency = totalPrompt > 0
    ? Math.round((totalCached / totalPrompt) * 100)
    : 0;

  // Tokens de llamadas en segundo plano (director de escena, resúmenes, índice
  // de contexto...) — acumulados por el servidor en conversation.metadata.
  // Sin esto, el coste mostrado no era el coste real.
  const bg = conversation.metadata?.bgTokens as import('@rpgspeak/shared').BackgroundTokenUsage | undefined;
  const bgTotal = bg ? bg.prompt + bg.completion : 0;
  const realTotal = conversation.tokenCount + bgTotal;

  const rows: { label: string; value: string; accent?: boolean }[] = [
    { label: 'Mensajes', value: String(conversation.messageCount) },
    { label: 'Tokens del chat', value: conversation.tokenCount.toLocaleString('es-ES') },
    ...(bgTotal > 0 ? [
      { label: 'Tokens de fondo', value: bgTotal.toLocaleString('es-ES') },
      { label: 'Tokens totales (coste real)', value: realTotal.toLocaleString('es-ES'), accent: true },
    ] : []),
    { label: 'Creada', value: formatDate(conversation.createdAt) },
    { label: 'Modo', value: conversation.mode },
    {
      label: 'Personajes',
      value: charNames.length > 0 ? charNames.join(', ') : '—',
    },
    {
      label: 'Historias enlazadas',
      value: storyNames.length > 0 ? storyNames.join(', ') : '—',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div
        className="relative w-full max-w-md mx-4 rounded-2xl border border-border shadow-2xl animate-fade-in"
        style={{ background: 'var(--surface-1)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="font-semibold text-sm">Estadísticas</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Rows */}
        <div className="px-5 py-4 space-y-3">
          {rows.map((row) => (
            <div key={row.label} className="flex justify-between gap-4">
              <span className="text-xs text-text-muted flex-shrink-0">{row.label}</span>
              <span className={`text-xs text-right ${row.accent ? 'text-emerald-400' : 'text-text-primary'}`}>
                {row.value}
              </span>
            </div>
          ))}

          {/* Token breakdown — only shown when per-message data is available */}
          {hasTokenBreakdown && (
            <>
              <div className="border-t border-border pt-3 mt-1">
                <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2">
                  Desglose de tokens
                </p>
                <div className="space-y-2">
                  <div className="flex justify-between gap-4">
                    <span className="text-xs text-text-muted">Tokens de entrada (prompt)</span>
                    <span className="text-xs text-text-primary tabular-nums">{fmt(totalPrompt)}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-xs text-text-muted">Tokens generados</span>
                    <span className="text-xs text-text-primary tabular-nums">{fmt(totalCompletion)}</span>
                  </div>
                  {totalCached > 0 && (
                    <>
                      <div className="flex justify-between gap-4">
                        <span className="text-xs text-text-muted">Tokens ahorrados (caché)</span>
                        <span className="text-xs text-emerald-400 tabular-nums">{fmt(totalCached)}</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-xs text-text-muted">Eficiencia de caché</span>
                        <span className="text-xs text-emerald-400 tabular-nums font-medium">{cacheEfficiency}%</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Llamadas de fondo — coste real, nada oculto */}
          {bg && bgTotal > 0 && (
            <div className="border-t border-border pt-3 mt-1">
              <p className="text-[10px] font-semibold text-violet-400 uppercase tracking-wider mb-2">
                Llamadas en segundo plano · {bg.calls} llamada{bg.calls !== 1 ? 's' : ''}
              </p>
              <div className="space-y-2">
                {Object.entries(bg.byLabel).map(([label, t]) => (
                  <div key={label} className="flex justify-between gap-4">
                    <span className="text-xs text-text-muted">{BG_LABEL_NAMES[label] ?? label}</span>
                    <span className="text-xs text-text-primary tabular-nums">{fmt(t.prompt + t.completion)}</span>
                  </div>
                ))}
                <div className="flex justify-between gap-4 border-t border-border/60 pt-2">
                  <span className="text-xs text-text-muted font-medium">Total fondo</span>
                  <span className="text-xs text-violet-400 tabular-nums font-medium">{fmt(bgTotal)}</span>
                </div>
                {bg.cached > 0 && (
                  <div className="flex justify-between gap-4">
                    <span className="text-xs text-text-muted">Caché de fondo</span>
                    <span className="text-xs text-emerald-400 tabular-nums">{fmt(bg.cached)}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end px-5 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs border border-border text-text-muted hover:text-text-primary transition-colors"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
