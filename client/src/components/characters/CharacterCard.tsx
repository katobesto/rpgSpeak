import React from 'react';
import { Copy, Edit2, Trash2, MessageSquarePlus, UserCircle, Lock } from 'lucide-react';
import type { Character, Story } from '@rpgspeak/shared';
import { Avatar } from '../ui/Avatar.tsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { charactersApi } from '../../api/characters.ts';
import { conversationsApi } from '../../api/conversations.ts';
import { useChatStore } from '../../stores/chat.store.ts';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth.store.ts';

interface CharacterCardProps {
  character: Character;
  onEdit: (character: Character) => void;
  stories?: Story[];
}

export function CharacterCard({ character, onEdit, stories = [] }: CharacterCardProps) {
  const qc = useQueryClient();
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const navigate = useNavigate();
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const canEdit = isAdmin || character.userId === currentUserId;

  const duplicate = useMutation({
    mutationFn: () => charactersApi.duplicate(character.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['characters'] }),
  });

  const remove = useMutation({
    mutationFn: () => charactersApi.delete(character.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['characters'] }),
  });

  const startChat = useMutation({
    mutationFn: () =>
      conversationsApi.create({
        title: `Chat with ${character.name}`,
        characterIds: [character.id],
      }),
    onSuccess: (conv) => {
      setActiveConversation(conv);
      qc.invalidateQueries({ queryKey: ['conversations'] });
      navigate('/');
    },
  });

  return (
    <div className="group relative rounded-xl border border-border overflow-hidden transition-all hover:border-accent/40 hover:shadow-lg animate-fade-in"
      style={{ background: 'var(--surface-1)' }}>
      {/* Top color bar */}
      <div className="h-1 bg-gradient-to-r from-violet-600 to-indigo-600" />

      <div className="p-4">
        <div className="flex items-start gap-3">
          <Avatar name={character.name} src={character.avatar} size="md" />
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm truncate">{character.name}</h3>
            <p className="text-xs text-text-muted truncate-2 mt-0.5 leading-relaxed">
              {character.description || character.personality || 'No description'}
            </p>
          </div>
        </div>

        {/* Owner / read-only badge */}
        {!canEdit && !isAdmin && (
          <div className="flex items-center gap-1 mt-2">
            <Lock size={10} className="text-text-muted flex-shrink-0" />
            <span className="text-[10px] text-text-muted">Solo lectura</span>
          </div>
        )}
        {isAdmin && character.ownerName && character.userId !== currentUserId && (
          <div className="flex items-center gap-1 mt-2">
            <UserCircle size={11} className="text-text-muted flex-shrink-0" />
            <span className="text-[10px] text-text-muted truncate">{character.ownerName}</span>
          </div>
        )}

        {/* Tags */}
        {character.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {character.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="px-2 py-0.5 rounded-full text-[10px] bg-accent-muted text-accent">
                {tag}
              </span>
            ))}
            {character.tags.length > 4 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] text-text-muted">
                +{character.tags.length - 4}
              </span>
            )}
          </div>
        )}

        {/* Story chips */}
        {character.storyIds.length > 0 && stories.length > 0 && (() => {
          const linked = character.storyIds
            .map((id) => stories.find((s) => s.id === id))
            .filter(Boolean) as Story[];
          if (linked.length === 0) return null;
          return (
            <div className="flex flex-wrap gap-1 mt-2">
              {linked.slice(0, 2).map((s) => (
                <span key={s.id} className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 truncate max-w-[120px]">
                  {s.name}
                </span>
              ))}
              {linked.length > 2 && (
                <span className="px-2 py-0.5 rounded-full text-[10px] text-text-muted">
                  +{linked.length - 2}
                </span>
              )}
            </div>
          );
        })()}

        {/* Actions */}
        <div className="flex items-center gap-1 mt-3 pt-3 border-t border-border">
          <button
            onClick={() => startChat.mutate()}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs bg-accent hover:bg-accent-hover text-white transition-colors flex-1 justify-center"
          >
            <MessageSquarePlus size={12} /> Chat
          </button>
          {canEdit && (
            <>
              <button
                onClick={() => onEdit(character)}
                className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
                title="Editar"
              >
                <Edit2 size={13} />
              </button>
              <button
                onClick={() => duplicate.mutate()}
                className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
                title="Duplicar"
              >
                <Copy size={13} />
              </button>
              <button
                onClick={() => { if (confirm(`¿Eliminar "${character.name}"?`)) remove.mutate(); }}
                className="p-1.5 rounded-lg hover:bg-red-500/10 text-text-muted hover:text-red-400 transition-colors"
                title="Eliminar"
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
