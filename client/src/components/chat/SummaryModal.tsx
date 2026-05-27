import React from 'react';
import { X, RefreshCw } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { conversationsApi } from '../../api/conversations.ts';

interface SummaryModalProps {
  open: boolean;
  onClose: () => void;
  summary: string | null;
  conversationId: string;
  onSummaryUpdated: (newSummary: string) => void;
}

export function SummaryModal({
  open,
  onClose,
  summary,
  conversationId,
  onSummaryUpdated,
}: SummaryModalProps) {
  const regenerate = useMutation({
    mutationFn: () => conversationsApi.summarize(conversationId),
    onSuccess: (updated) => {
      if (updated.summary) {
        onSummaryUpdated(updated.summary);
      }
    },
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div
        className="relative w-full max-w-lg mx-4 rounded-2xl border border-border shadow-2xl animate-fade-in"
        style={{ background: 'var(--surface-1)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="font-semibold text-sm">Resumen de sucesos</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4">
          {summary?.trim() ? (
            <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
              {summary}
            </p>
          ) : (
            <p className="text-sm text-text-muted italic">Aún no hay resumen.</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            onClick={() => regenerate.mutate()}
            disabled={regenerate.isPending}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={12} className={regenerate.isPending ? 'animate-spin' : ''} />
            {regenerate.isPending ? 'Generando...' : 'Regenerar con IA'}
          </button>
        </div>
      </div>
    </div>
  );
}
