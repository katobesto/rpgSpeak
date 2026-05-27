import React, { useState, useRef, useEffect } from 'react';
import { Send, Square, ChevronDown, Theater } from 'lucide-react';
import { useChatStore } from '../../stores/chat.store.ts';
import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '../../api/settings.ts';
import type { Character } from '@rpgspeak/shared';
import { Avatar } from '../ui/Avatar.tsx';

interface MessageInputProps {
  characters: Character[];
  activeCharacterId: string | null;
  onCharacterChange: (id: string) => void;
}

export function MessageInput({ characters, activeCharacterId, onCharacterChange }: MessageInputProps) {
  const [text, setText] = useState('');
  const [showCharMenu, setShowCharMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { sendMessage, abort, isStreaming, narratorMode, setNarratorMode } = useChatStore();

  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const sendOnEnter = settings?.sendOnEnter ?? true;

  const activeChar = characters.find((c) => c.id === activeCharacterId) ?? characters[0];

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }

  useEffect(() => { autoResize(); }, [text]);

  // Close menu on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowCharMenu(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    setText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    await sendMessage({ message: trimmed, characterId: narratorMode ? undefined : activeChar?.id });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter') {
      if (sendOnEnter && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      } else if (!sendOnEnter && e.ctrlKey) {
        e.preventDefault();
        handleSend();
      }
    }
  }

  const selectorLabel = narratorMode
    ? 'Narrador / Master'
    : (activeChar?.name ?? 'Seleccionar');

  const placeholder = narratorMode
    ? `Describe una acción o evento en la escena...${sendOnEnter ? '' : ' (Ctrl+Enter to send)'}`
    : `Mensaje para ${activeChar?.name ?? '...'}${sendOnEnter ? '' : ' (Ctrl+Enter to send)'}`;

  return (
    <div className="flex-shrink-0 border-t border-border px-4 py-3">
      {/* Unified Narrator/Character selector — always shown */}
      <div className="relative mb-2" ref={menuRef}>
        <button
          onClick={() => setShowCharMenu((v) => !v)}
          className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          {narratorMode ? (
            <div className="w-6 h-6 rounded-full bg-accent flex items-center justify-center flex-shrink-0">
              <Theater size={12} className="text-white" />
            </div>
          ) : (
            <Avatar name={activeChar?.name ?? '?'} src={activeChar?.avatar} size="xs" expandable />
          )}
          <span>{selectorLabel}</span>
          <ChevronDown size={12} />
        </button>

        {showCharMenu && (
          <div
            className="absolute bottom-full left-0 mb-1 w-52 rounded-xl border border-border py-1 z-10 shadow-xl animate-slide-up"
            style={{ background: 'var(--surface-2)' }}
          >
            {/* Narrator option */}
            <button
              onClick={() => { setNarratorMode(true); setShowCharMenu(false); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/5 text-left ${narratorMode ? 'text-accent' : ''}`}
            >
              <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center flex-shrink-0">
                <Theater size={12} className="text-accent" />
              </div>
              <span className="text-xs text-text-primary">Narrador / Master</span>
            </button>

            {/* Divider */}
            {characters.length > 0 && (
              <div className="border-t border-border mx-2 my-1" />
            )}

            {/* Character options */}
            {characters.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setNarratorMode(false);
                  onCharacterChange(c.id);
                  setShowCharMenu(false);
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/5 text-left ${!narratorMode && c.id === activeChar?.id ? 'text-accent' : ''}`}
              >
                <Avatar name={c.name} src={c.avatar} size="xs" expandable />
                <span className="text-xs text-text-primary">{c.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Input area */}
      <div
        className="flex items-end gap-2 rounded-2xl border border-border px-4 py-3 transition-colors focus-within:border-accent"
        style={{ background: 'var(--surface-2)' }}
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            // On Android Chrome the virtual keyboard can push content out of view.
            // scrollIntoView() nudges the browser to keep the input visible.
            setTimeout(() => textareaRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 120);
          }}
          placeholder={placeholder}
          rows={1}
          disabled={isStreaming}
          className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted resize-none focus:outline-none disabled:opacity-60"
          style={{ lineHeight: '1.5', maxHeight: '240px' }}
        />

        <button
          onClick={isStreaming ? abort : handleSend}
          disabled={!isStreaming && !text.trim()}
          className={`flex-shrink-0 p-2 rounded-xl transition-all ${
            isStreaming
              ? 'bg-red-600 hover:bg-red-700 text-white'
              : text.trim()
              ? 'bg-accent hover:bg-accent-hover text-white'
              : 'text-text-muted opacity-40 cursor-not-allowed'
          }`}
        >
          {isStreaming ? <Square size={16} fill="currentColor" /> : <Send size={16} />}
        </button>
      </div>

      <p className="text-[10px] text-text-muted mt-1.5 text-center">
        {sendOnEnter ? 'Enter to send · Shift+Enter for new line' : 'Ctrl+Enter to send · Enter for new line'}
      </p>
    </div>
  );
}
