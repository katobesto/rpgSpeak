import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import type { Message, Character } from '@rpgspeak/shared';

interface ChatSearchModalProps {
  messages: Message[];
  characters: Character[];
  /** Called when user selects a result. Parent must scroll to that index. */
  onJumpTo: (messageIndex: number, messageId: string) => void;
  onClose: () => void;
}

interface SearchResult {
  messageIndex: number;
  messageId: string;
  role: Message['role'];
  characterName?: string;
  before: string;
  match: string;
  after: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/#{1,6} /g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/```[\s\S]*?```/g, '[código]')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSnippet(
  plainText: string,
  query: string,
): { before: string; match: string; after: string } | null {
  const lower = plainText.toLowerCase();
  const qLower = query.toLowerCase().trim();
  const idx = lower.indexOf(qLower);
  if (idx === -1) return null;

  const CONTEXT = 75;
  const start = Math.max(0, idx - CONTEXT);
  const end = Math.min(plainText.length, idx + query.trim().length + CONTEXT);

  return {
    before: (start > 0 ? '…' : '') + plainText.slice(start, idx),
    match: plainText.slice(idx, idx + query.trim().length),
    after: plainText.slice(idx + query.trim().length, end) + (end < plainText.length ? '…' : ''),
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ChatSearchModal({ messages, characters, onJumpTo, onClose }: ChatSearchModalProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const charMap = useMemo(
    () => new Map(characters.map((c) => [c.id, c])),
    [characters],
  );

  // ── Build results (in-memory, fast) ──
  const results = useMemo<SearchResult[]>(() => {
    if (query.trim().length < 2) return [];
    const out: SearchResult[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      // Skip system messages that are UI-only (anchors, etc.)
      if (msg.role === 'system') continue;
      const plain = stripMarkdown(msg.content);
      const snippet = extractSnippet(plain, query);
      if (!snippet) continue;
      const char = msg.characterId ? charMap.get(msg.characterId) : undefined;
      out.push({
        messageIndex: i,
        messageId: msg.id,
        role: msg.role,
        characterName: char?.name,
        ...snippet,
      });
    }
    return out;
  }, [query, messages, charMap]);

  // Reset cursor when result set changes
  useEffect(() => { setSelectedIndex(0); }, [results.length, query]);

  // Auto-focus input
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Global keyboard nav
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      }
      if (e.key === 'Enter' && results[selectedIndex]) {
        onJumpTo(results[selectedIndex].messageIndex, results[selectedIndex].messageId);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [results, selectedIndex, onClose, onJumpTo]);

  // Keep selected result visible
  useEffect(() => {
    const el = resultsRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  function getRoleLabel(r: SearchResult) {
    if (r.role === 'user') return 'Tú';
    if (r.characterName) return r.characterName;
    return 'IA';
  }

  const hasQuery = query.trim().length >= 2;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] px-4"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-border shadow-2xl overflow-hidden animate-slide-up"
        style={{ background: 'var(--surface-1)' }}
      >
        {/* ── Search input row ── */}
        <div className="flex items-center gap-3 px-4 py-3.5">
          <Search size={16} className="text-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar en el chat…"
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <div className="flex items-center gap-0.5">
            {results.length > 0 && (
              <>
                <span className="text-[11px] text-text-muted px-1.5">
                  {selectedIndex + 1}&thinsp;/&thinsp;{results.length}
                </span>
                <button
                  onClick={() => setSelectedIndex((i) => Math.max(i - 1, 0))}
                  disabled={selectedIndex === 0}
                  className="p-1 rounded hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors disabled:opacity-30"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  onClick={() => setSelectedIndex((i) => Math.min(i + 1, results.length - 1))}
                  disabled={selectedIndex === results.length - 1}
                  className="p-1 rounded hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors disabled:opacity-30"
                >
                  <ChevronDown size={14} />
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors ml-1"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* ── Results ── */}
        {hasQuery && (
          <>
            <div className="border-t border-border" />
            <div ref={resultsRef} className="max-h-[52vh] overflow-y-auto">
              {results.length === 0 ? (
                <div className="py-10 text-center">
                  <p className="text-sm text-text-muted">
                    Sin resultados para{' '}
                    <span className="text-text-primary font-medium">"{query}"</span>
                  </p>
                </div>
              ) : (
                results.map((r, i) => (
                  <button
                    key={`${r.messageId}-${i}`}
                    onClick={() => onJumpTo(r.messageIndex, r.messageId)}
                    className={`w-full text-left px-4 py-3 border-b border-border/60 last:border-b-0 transition-colors ${
                      i === selectedIndex
                        ? 'bg-accent/10'
                        : 'hover:bg-white/4'
                    }`}
                  >
                    {/* Label row */}
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`text-[10px] font-bold uppercase tracking-wider ${
                          r.role === 'user' ? 'text-accent' : 'text-emerald-400'
                        }`}
                      >
                        {getRoleLabel(r)}
                      </span>
                      <span className="text-[10px] text-text-muted">
                        #{r.messageIndex + 1}
                      </span>
                    </div>
                    {/* Snippet */}
                    <p className="text-xs leading-relaxed text-text-muted line-clamp-2">
                      {r.before}
                      <mark
                        className="rounded px-0.5 font-semibold not-italic"
                        style={{
                          background: 'rgba(var(--accent-rgb,139,92,246),0.25)',
                          color: 'var(--accent)',
                        }}
                      >
                        {r.match}
                      </mark>
                      {r.after}
                    </p>
                  </button>
                ))
              )}
            </div>
          </>
        )}

        {/* ── Keyboard hints ── */}
        <div
          className="flex items-center gap-4 px-4 py-2 border-t border-border"
          style={{ background: 'var(--surface-2)' }}
        >
          {[['↑↓', 'navegar'], ['↵', 'saltar'], ['Esc', 'cerrar']].map(([key, hint]) => (
            <span key={key} className="flex items-center gap-1 text-[10px] text-text-muted">
              <kbd
                className="px-1 py-0.5 rounded text-[9px] border border-border font-mono"
                style={{ background: 'var(--surface-1)' }}
              >
                {key}
              </kbd>
              {hint}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
