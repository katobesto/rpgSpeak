import React, { useEffect, useRef, useCallback, useImperativeHandle } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { MessageItem } from './MessageItem.tsx';
import type { Message, Character } from '@rpgspeak/shared';
import { useChatStore } from '../../stores/chat.store.ts';

export interface MessageListHandle {
  /** Scroll the virtualizer so that the item at `index` is centered. */
  scrollToMessageIndex: (index: number) => void;
}

interface MessageListProps {
  messages: Message[];
  characters: Character[];
  /** When set, that message gets a brief highlight flash. */
  highlightedMessageId?: string | null;
}

export const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(
  function MessageList({ messages, characters, highlightedMessageId }, ref) {
    const parentRef = useRef<HTMLDivElement>(null);
    const isStreaming = useChatStore((s) => s.isStreaming);
    const streamingContent = useChatStore((s) => s.streamingContent);
    const streamingMessageId = useChatStore((s) => s.streamingMessageId);

    // Whether the user manually scrolled after the last auto-scroll
    const userScrolledAfterAuto = useRef(false);

    const charMap = React.useMemo(
      () => new Map(characters.map((c) => [c.id, c])),
      [characters],
    );

    const virtualizer = useVirtualizer({
      count: messages.length,
      getScrollElement: () => parentRef.current,
      estimateSize: () => 160,
      overscan: 5,
    });

    // ── Expose scroll API to parent ──
    useImperativeHandle(ref, () => ({
      scrollToMessageIndex: (index: number) => {
        userScrolledAfterAuto.current = false;
        virtualizer.scrollToIndex(index, { align: 'center', behavior: 'auto' });
        // Second pass after measure to correct position
        setTimeout(() => {
          virtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
        }, 80);
      },
    }));

    // Scroll so the top of the last message is visible — lets the user read
    // from the beginning of the response without chasing the growing bottom edge.
    const scrollToLastMessageStart = useCallback(() => {
      const idx = messages.length - 1;
      if (idx < 0) return;
      virtualizer.scrollToIndex(idx, { align: 'start', behavior: 'instant' });
    }, [messages.length, virtualizer]);

    // Detect manual scrolling so we don't fight the user within 100 ms of auto-scroll
    useEffect(() => {
      const el = parentRef.current;
      if (!el) return;
      function onScroll() {
        userScrolledAfterAuto.current = true;
      }
      el.addEventListener('scroll', onScroll, { passive: true });
      return () => el.removeEventListener('scroll', onScroll);
    }, []);

    // New message added / conversation loaded → scroll to the TOP of the last message.
    // Two-pass: first pass positions against the virtualizer estimate; second pass
    // (100 ms later) corrects once actual heights are measured — but only if the
    // user hasn't scrolled in the meantime.
    useEffect(() => {
      if (messages.length === 0) return;
      userScrolledAfterAuto.current = false;
      scrollToLastMessageStart();
      const id = setTimeout(() => {
        if (!userScrolledAfterAuto.current) scrollToLastMessageStart();
      }, 100);
      return () => clearTimeout(id);
    }, [messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

    // During streaming: intentionally NO auto-scroll.
    void isStreaming;
    void streamingContent;

    if (messages.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-2">
            <p className="text-text-muted text-sm">No messages yet.</p>
            <p className="text-text-muted text-xs">Send a message to start the conversation.</p>
          </div>
        </div>
      );
    }

    const items = virtualizer.getVirtualItems();

    return (
      <div ref={parentRef} className="flex-1 overflow-y-auto">
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
          {items.map((virtualItem) => {
            const message = messages[virtualItem.index];
            const character = message.characterId ? charMap.get(message.characterId) : undefined;
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <MessageItem
                  message={message}
                  characterName={character?.name}
                  characterAvatar={character?.avatar}
                  groupCharacters={characters}
                  isStreaming={isStreaming && message.id === streamingMessageId}
                  highlighted={message.id === highlightedMessageId}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  },
);
