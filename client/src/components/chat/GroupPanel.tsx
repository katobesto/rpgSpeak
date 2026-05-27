import React, { useState } from 'react';
import { X, Plus, Minus, BookOpen } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { charactersApi } from '../../api/characters.ts';
import { storiesApi } from '../../api/stories.ts';
import { conversationsApi } from '../../api/conversations.ts';
import { useChatStore } from '../../stores/chat.store.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { CharacterMemoriesModal } from './CharacterMemoriesModal.tsx';
import type { Character, Story, ConversationCharacterLink } from '@rpgspeak/shared';

interface GroupPanelProps {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  currentCharacterIds: string[];
  currentStoryIds: string[];
  characterLinks?: ConversationCharacterLink[];
  onUpdate: (characterIds: string[], storyIds: string[]) => void;
}

type Tab = 'characters' | 'stories';

function affinityColor(v: number): string {
  if (v >= 80) return 'text-green-400';
  if (v >= 40) return 'text-yellow-400';
  return 'text-red-400';
}

export function GroupPanel({
  open,
  onClose,
  conversationId,
  currentCharacterIds,
  currentStoryIds,
  characterLinks = [],
  onUpdate,
}: GroupPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('characters');
  const [memoriesFor, setMemoriesFor] = useState<{ id: string; name: string } | null>(null);
  const updateCharacterAffinities = useChatStore((s) => s.updateCharacterAffinities);

  const { data: allCharacters = [] } = useQuery({
    queryKey: ['characters'],
    queryFn: () => charactersApi.list(),
  });

  const { data: allStories = [] } = useQuery({
    queryKey: ['stories'],
    queryFn: () => storiesApi.list(),
  });

  function addCharacter(id: string) {
    onUpdate([...currentCharacterIds, id], currentStoryIds);
  }

  function removeCharacter(id: string) {
    onUpdate(currentCharacterIds.filter((c) => c !== id), currentStoryIds);
  }

  function addStory(id: string) {
    onUpdate(currentCharacterIds, [...currentStoryIds, id]);
  }

  function removeStory(id: string) {
    onUpdate(currentCharacterIds, currentStoryIds.filter((s) => s !== id));
  }

  async function changeAffinity(charId: string, currentAffinity: number, delta: number) {
    const newAffinity = Math.max(1, Math.min(100, currentAffinity + delta));
    await conversationsApi.updateCharacterAffinity(conversationId, charId, newAffinity);
    updateCharacterAffinities([{ characterId: charId, newAffinity }]);
  }

  const currentChars: Character[] = allCharacters.filter((c) => currentCharacterIds.includes(c.id));
  const availableChars: Character[] = allCharacters.filter((c) => !currentCharacterIds.includes(c.id));

  const currentStories: Story[] = allStories.filter((s) => currentStoryIds.includes(s.id));
  const availableStories: Story[] = allStories.filter((s) => !currentStoryIds.includes(s.id));

  return (
    <>
      {/* Overlay */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        className={`fixed right-0 top-0 h-full w-80 z-40 flex flex-col transition-transform duration-300 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ background: 'var(--surface-1)', borderLeft: '1px solid var(--border)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-border"
          style={{ background: 'var(--surface-1)' }}
        >
          <h2 className="font-semibold text-sm">Grupo de conversación</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex border-b border-border">
          {(['characters', 'stories'] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
                activeTab === tab
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {tab === 'characters' ? 'Personajes' : 'Historias'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {activeTab === 'characters' && (
            <>
              {/* Current characters */}
              {currentChars.length > 0 && (
                <section>
                  <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2">
                    En la conversación
                  </p>
                  <div className="space-y-1.5">
                    {currentChars.map((c) => {
                      const link = characterLinks.find((l) => l.characterId === c.id);
                      const affinity = link?.affinity ?? 50;
                      return (
                        <div
                          key={c.id}
                          className="flex items-center gap-2 p-2 rounded-lg"
                          style={{ background: 'var(--surface-2)' }}
                        >
                          <Avatar name={c.name} src={c.avatar} size="xs" expandable />
                          <span className="flex-1 text-xs text-text-primary truncate">{c.name}</span>
                          {/* Affinity controls */}
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={() => changeAffinity(c.id, affinity, -5)}
                              className="p-0.5 rounded hover:bg-white/10 text-text-muted hover:text-text-primary transition-colors"
                              title="Reducir afinidad (-5)"
                            >
                              <Minus size={10} />
                            </button>
                            <span
                              className={`text-[10px] font-mono font-semibold w-6 text-center ${affinityColor(affinity)}`}
                              title={`Afinidad: ${affinity}/100${affinity >= 80 ? ' (enamorado/a)' : ''}`}
                            >
                              {affinity}
                            </span>
                            <button
                              onClick={() => changeAffinity(c.id, affinity, 5)}
                              className="p-0.5 rounded hover:bg-white/10 text-text-muted hover:text-text-primary transition-colors"
                              title="Aumentar afinidad (+5)"
                            >
                              <Plus size={10} />
                            </button>
                          </div>
                          <button
                            onClick={() => setMemoriesFor({ id: c.id, name: c.name })}
                            className="p-1 rounded hover:bg-accent/20 text-text-muted hover:text-accent transition-colors flex-shrink-0"
                            title="Ver memorias"
                          >
                            <BookOpen size={12} />
                          </button>
                          <button
                            onClick={() => removeCharacter(c.id)}
                            className="p-1 rounded hover:bg-red-500/20 text-text-muted hover:text-red-400 transition-colors flex-shrink-0"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Available characters */}
              {availableChars.length > 0 && (
                <section>
                  <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2">
                    Disponibles
                  </p>
                  <div className="space-y-1.5">
                    {availableChars.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-white/4 transition-colors"
                      >
                        <Avatar name={c.name} src={c.avatar} size="xs" expandable />
                        <span className="flex-1 text-xs text-text-secondary truncate">{c.name}</span>
                        <button
                          onClick={() => addCharacter(c.id)}
                          className="p-1 rounded hover:bg-accent/20 text-text-muted hover:text-accent transition-colors"
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {allCharacters.length === 0 && (
                <p className="text-xs text-text-muted text-center py-4">
                  No hay personajes disponibles.
                </p>
              )}
            </>
          )}

          {activeTab === 'stories' && (
            <>
              {/* Current stories */}
              {currentStories.length > 0 && (
                <section>
                  <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2">
                    Enlazadas
                  </p>
                  <div className="space-y-1.5">
                    {currentStories.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-start gap-2.5 p-2 rounded-lg"
                        style={{ background: 'var(--surface-2)' }}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-text-primary font-medium truncate">{s.name}</p>
                          {s.description && (
                            <p className="text-[10px] text-text-muted truncate mt-0.5">{s.description}</p>
                          )}
                        </div>
                        <button
                          onClick={() => removeStory(s.id)}
                          className="p-1 rounded hover:bg-red-500/20 text-text-muted hover:text-red-400 transition-colors flex-shrink-0"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Available stories */}
              {availableStories.length > 0 && (
                <section>
                  <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2">
                    Disponibles
                  </p>
                  <div className="space-y-1.5">
                    {availableStories.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-start gap-2.5 p-2 rounded-lg hover:bg-white/4 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-text-secondary font-medium truncate">{s.name}</p>
                          {s.description && (
                            <p className="text-[10px] text-text-muted truncate mt-0.5">{s.description}</p>
                          )}
                        </div>
                        <button
                          onClick={() => addStory(s.id)}
                          className="p-1 rounded hover:bg-accent/20 text-text-muted hover:text-accent transition-colors flex-shrink-0"
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {allStories.length === 0 && (
                <p className="text-xs text-text-muted text-center py-4">
                  No hay historias disponibles.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {memoriesFor && (
        <CharacterMemoriesModal
          characterId={memoriesFor.id}
          characterName={memoriesFor.name}
          conversationId={conversationId}
          onClose={() => setMemoriesFor(null)}
        />
      )}
    </>
  );
}
