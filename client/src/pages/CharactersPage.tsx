import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { charactersApi } from '../api/characters.ts';
import { storiesApi } from '../api/stories.ts';
import { CharacterCard } from '../components/characters/CharacterCard.tsx';
import { CharacterEditor } from '../components/characters/CharacterEditor.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Plus, Search, Upload, BookOpen, X } from 'lucide-react';
import type { Character } from '@rpgspeak/shared';

export function CharactersPage() {
  const [search, setSearch] = useState('');
  const [storyFilter, setStoryFilter] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingChar, setEditingChar] = useState<Character | null>(null);

  const { data: stories = [] } = useQuery({
    queryKey: ['stories'],
    queryFn: () => storiesApi.list(),
  });

  const { data: characters = [], isLoading } = useQuery({
    queryKey: ['characters', search, storyFilter],
    queryFn: () => charactersApi.list(search || undefined, storyFilter || undefined),
  });

  function openCreate() {
    setEditingChar(null);
    setEditorOpen(true);
  }

  function openEdit(char: Character) {
    setEditingChar(char);
    setEditorOpen(true);
  }

  function exportChar(char: Character) {
    const json = JSON.stringify(char, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${char.name.replace(/\s+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importChar() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const data = JSON.parse(text);
      await charactersApi.import(data);
    };
    input.click();
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-border"
        style={{ background: 'var(--surface-1)' }}>
        <div>
          <h1 className="text-lg font-semibold">Characters</h1>
          <p className="text-xs text-text-muted">{characters.length} characters</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={importChar}
            className="p-2 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors" title="Import JSON">
            <Upload size={15} />
          </button>
          <Button onClick={openCreate} size="sm">
            <Plus size={14} /> New Character
          </Button>
        </div>
      </div>

      {/* Search + story filter */}
      <div className="flex-shrink-0 px-6 py-3 border-b border-border flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search characters..."
            className="w-full pl-9 pr-4 py-2 rounded-lg text-sm border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            style={{ background: 'var(--surface-2)' }}
          />
        </div>
        {stories.length > 0 && (
          <div className="relative flex items-center">
            <BookOpen size={14} className="absolute left-3 text-text-muted pointer-events-none" />
            <select
              value={storyFilter}
              onChange={(e) => setStoryFilter(e.target.value)}
              className="pl-8 pr-7 py-2 rounded-lg text-sm border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent appearance-none cursor-pointer"
              style={{ background: 'var(--surface-2)', color: storyFilter ? 'var(--text-primary)' : 'var(--text-muted)' }}
            >
              <option value="">Todas las historias</option>
              {stories.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {storyFilter && (
              <button
                onClick={() => setStoryFilter('')}
                className="absolute right-2 text-text-muted hover:text-text-primary transition-colors"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">Loading...</div>
        ) : characters.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="w-16 h-16 rounded-2xl bg-accent-muted flex items-center justify-center text-3xl">🎭</div>
            <div className="text-center">
              <p className="font-medium">No characters yet</p>
              <p className="text-text-muted text-sm mt-1">Create your first character to get started.</p>
            </div>
            <Button onClick={openCreate}><Plus size={14} /> Create Character</Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {characters.map((char) => (
              <CharacterCard key={char.id} character={char} onEdit={openEdit} stories={stories} />
            ))}
          </div>
        )}
      </div>

      <CharacterEditor key={editingChar?.id ?? 'new'} open={editorOpen} character={editingChar} onClose={() => setEditorOpen(false)} />
    </div>
  );
}
