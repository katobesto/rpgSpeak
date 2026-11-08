import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { storiesApi } from '../../api/stories.ts';
import { charactersApi } from '../../api/characters.ts';
import { Modal } from '../ui/Modal.tsx';
import { Button } from '../ui/Button.tsx';
import { Input, Textarea } from '../ui/Input.tsx';
import type {
  StoryAssistantBriefing,
  StoryAssistantResult,
  StoryAssistantCharacterHint,
  CreateCharacterDto,
  CreateStoryDto,
} from '@rpgspeak/shared';
import { Plus, Trash2, Sparkles, Wand2, Users, MapPin, Zap, RefreshCw } from 'lucide-react';

/** crypto.randomUUID() only works in secure contexts (HTTPS / localhost). */
function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

interface StoryAssistantProps {
  open: boolean;
  onClose: () => void;
}

const DEFAULT_BRIEFING: StoryAssistantBriefing = {
  theme: '',
  genre: '',
  tone: '',
  pacing: 3,
  numCharacters: 3,
  numEvents: 5,
  numLocations: 4,
  adventureMode: false,
  openWorld: false,
  characterHints: [],
  extra: '',
};

const PACING_LABELS = ['Muy pausado', 'Pausado', 'Equilibrado', 'Ágil', 'Frenético'];
const PACING_HINTS = [
  'Introspección, detalle y desarrollo emocional. Pocos sucesos, construidos con calma.',
  'Atmósfera y personajes; los giros llegan poco a poco.',
  'Alterna calma con escenas de acción o tensión.',
  'Suceden cosas a menudo; tensión alta y sorpresas frecuentes.',
  'Acontecimientos sorprendentes sin parar; nunca hay tiempos muertos.',
];

/** Builds a full CreateCharacterDto from an assistant draft, using schema defaults. */
function draftToCharacterDto(
  draft: StoryAssistantResult['characters'][number],
): CreateCharacterDto {
  return {
    name: draft.name,
    avatar: null,
    description: draft.description,
    personality: draft.personality,
    systemPrompt: '',
    lore: draft.lore,
    exampleDialogue: [],
    tags: draft.tags,
    temperature: 0.8,
    modelId: null,
    providerId: null,
    contextLength: 4096,
    memoryEnabled: true,
    memoryType: 'rolling',
    memoryWindow: 20,
    llmParams: {},
    relations: [],
    rpgStats: {},
    imageDescription: null,
    gallery: [],
  };
}

export function StoryAssistant({ open, onClose }: StoryAssistantProps) {
  const [step, setStep] = useState<'briefing' | 'preview'>('briefing');
  const [briefing, setBriefing] = useState<StoryAssistantBriefing>(DEFAULT_BRIEFING);
  const [result, setResult] = useState<StoryAssistantResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [storyName, setStoryName] = useState('');
  const qc = useQueryClient();

  function set<K extends keyof StoryAssistantBriefing>(key: K, value: StoryAssistantBriefing[K]) {
    setBriefing((b) => ({ ...b, [key]: value }));
  }

  function reset() {
    setStep('briefing');
    setBriefing(DEFAULT_BRIEFING);
    setResult(null);
    setSelected(new Set());
    setStoryName('');
  }

  function handleClose() {
    reset();
    onClose();
  }

  // ── Hint rows ──
  function addHint() {
    if (briefing.characterHints.length >= briefing.numCharacters) return;
    set('characterHints', [...briefing.characterHints, { name: '', notes: '' }]);
  }
  function updateHint(i: number, field: keyof StoryAssistantCharacterHint, value: string) {
    const updated = [...briefing.characterHints];
    updated[i] = { ...updated[i], [field]: value };
    set('characterHints', updated);
  }
  function removeHint(i: number) {
    set('characterHints', briefing.characterHints.filter((_, idx) => idx !== i));
  }

  // ── Generate ──
  const generateMut = useMutation({
    mutationFn: () => storiesApi.runAssistant(briefing),
    onSuccess: (res) => {
      setResult(res);
      setStoryName(res.story.name);
      setSelected(new Set(res.characters.map((_, i) => i)));
      setStep('preview');
    },
  });

  // ── Save (create characters + story) ──
  const saveMut = useMutation({
    mutationFn: async () => {
      if (!result) throw new Error('No hay resultado que guardar');
      // 1. Create selected characters, keeping their role for the story link
      const links: { characterId: string; role: string; notes: string }[] = [];
      for (let i = 0; i < result.characters.length; i++) {
        if (!selected.has(i)) continue;
        const draft = result.characters[i];
        const created = await charactersApi.create(draftToCharacterDto(draft));
        links.push({ characterId: created.id, role: draft.role, notes: '' });
      }
      // 2. Create the story with its events, locations and character links
      const now = new Date().toISOString();
      const dto: CreateStoryDto = {
        name: storyName.trim() || result.story.name,
        description: result.story.description,
        globalContext: result.story.globalContext,
        narrativeRules: result.story.narrativeRules,
        worldLore: result.story.worldLore,
        persistentEvents: result.story.events.map((e) => ({
          id: randomId(),
          timestamp: now,
          ...e,
        })),
        locations: result.story.locations.map((l) => ({ id: randomId(), ...l })),
        stateVariables: {},
        behaviorRestrictions: [],
        isActive: false,
        adventureMode: briefing.adventureMode,
        openWorld: briefing.openWorld,
        // El asistente no tiene UI para el modo muerte: se crea siempre apagado.
        deathMode: false,
        characters: links,
      };
      return storiesApi.create(dto);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stories'] });
      qc.invalidateQueries({ queryKey: ['characters'] });
      handleClose();
    },
  });

  function toggleChar(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  const canGenerate = briefing.theme.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={
        step === 'briefing'
          ? 'Asistente de historias'
          : `Revisar: ${storyName || result?.story.name || ''}`
      }
      size="xl"
      footer={
        step === 'briefing' ? (
          <>
            <Button variant="ghost" onClick={handleClose}>Cancelar</Button>
            <Button onClick={() => generateMut.mutate()} loading={generateMut.isPending} disabled={!canGenerate}>
              <Wand2 size={14} /> {generateMut.isPending ? 'Generando…' : 'Generar historia'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep('briefing')} disabled={saveMut.isPending}>
              ← Volver
            </Button>
            <Button variant="outline" onClick={() => generateMut.mutate()} loading={generateMut.isPending} disabled={saveMut.isPending}>
              <RefreshCw size={13} /> Regenerar
            </Button>
            <Button onClick={() => saveMut.mutate()} loading={saveMut.isPending}>
              Guardar historia y {selected.size} {selected.size === 1 ? 'personaje' : 'personajes'}
            </Button>
          </>
        )
      }
    >
      {/* ─────────────── STEP: BRIEFING ─────────────── */}
      {step === 'briefing' && (
        <div className="space-y-4">
          <div className="flex items-start gap-2 p-3 rounded-xl bg-accent/10 border border-accent/30">
            <Sparkles size={16} className="text-accent mt-0.5 flex-shrink-0" />
            <p className="text-xs text-text-secondary leading-relaxed">
              Describe lo que quieres y el LLM configurado generará una ficha de historia completa con
              sus personajes, eventos y ubicaciones. Podrás revisarlo antes de guardar.
            </p>
          </div>

          <Textarea
            label="Temática / premisa *"
            value={briefing.theme}
            onChange={(e) => set('theme', e.target.value)}
            placeholder="ej. Un grupo de náufragos descubre que la isla en la que están atrapados susurra sus peores recuerdos…"
            rows={3}
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Género"
              value={briefing.genre}
              onChange={(e) => set('genre', e.target.value)}
              placeholder="fantasía, ciencia ficción, terror…"
            />
            <Input
              label="Tono"
              value={briefing.tone}
              onChange={(e) => set('tone', e.target.value)}
              placeholder="épico, oscuro, cómico, romántico…"
            />
          </div>

          {/* Pacing slider */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
                <Zap size={12} className="text-accent" /> Ritmo de la historia
              </label>
              <span className="text-xs font-semibold text-accent">{PACING_LABELS[briefing.pacing - 1]}</span>
            </div>
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              value={briefing.pacing}
              onChange={(e) => set('pacing', parseInt(e.target.value))}
              className="w-full accent-violet-600"
            />
            <div className="flex justify-between text-[10px] text-text-muted px-0.5">
              <span>Contemplativo</span>
              <span>Frenético</span>
            </div>
            <p className="text-[11px] text-text-muted leading-relaxed">{PACING_HINTS[briefing.pacing - 1]}</p>
          </div>

          {/* Counts */}
          <div className="grid grid-cols-3 gap-3">
            <NumberField label="Personajes" value={briefing.numCharacters} min={1} max={8}
              onChange={(v) => {
                set('numCharacters', v);
                if (briefing.characterHints.length > v) {
                  set('characterHints', briefing.characterHints.slice(0, v));
                }
              }} />
            <NumberField label="Eventos" value={briefing.numEvents} min={0} max={15}
              onChange={(v) => set('numEvents', v)} />
            <NumberField label="Ubicaciones" value={briefing.numLocations} min={0} max={15}
              onChange={(v) => set('numLocations', v)} />
          </div>

          {/* Mode toggles */}
          <div className="grid grid-cols-2 gap-3">
            <ToggleCard
              active={briefing.adventureMode}
              onClick={() => set('adventureMode', !briefing.adventureMode)}
              title="Modo Aventura / RPG"
              desc="La IA narra como Game Master y gestiona mecánicas de rol."
            />
            <ToggleCard
              active={briefing.openWorld}
              onClick={() => set('openWorld', !briefing.openWorld)}
              title="Mundo abierto"
              desc="El narrador puede crear ubicaciones nuevas coherentes."
            />
          </div>

          {/* Character hints */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
                <Users size={12} /> Personajes sugeridos (opcional)
              </label>
              <Button size="sm" variant="outline" onClick={addHint}
                disabled={briefing.characterHints.length >= briefing.numCharacters}>
                <Plus size={12} /> Añadir
              </Button>
            </div>
            <p className="text-[11px] text-text-muted">
              Sugiere nombres y características aproximadas. La IA completará el resto e inventará los que falten
              hasta llegar a {briefing.numCharacters}.
            </p>
            {briefing.characterHints.map((h, i) => (
              <div key={i} className="flex gap-2 items-start">
                <input
                  value={h.name}
                  onChange={(e) => updateHint(i, 'name', e.target.value)}
                  placeholder="Nombre"
                  className="w-32 rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <input
                  value={h.notes}
                  onChange={(e) => updateHint(i, 'notes', e.target.value)}
                  placeholder="Características / rol aproximado"
                  className="flex-1 rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <button onClick={() => removeHint(i)} className="p-2 text-text-muted hover:text-red-400">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>

          <Textarea
            label="Notas adicionales (opcional)"
            value={briefing.extra}
            onChange={(e) => set('extra', e.target.value)}
            placeholder="Cualquier detalle extra: restricciones, inspiraciones, final deseado…"
            rows={2}
          />

          {generateMut.isError && (
            <p className="text-xs text-red-400">
              {(generateMut.error as Error)?.message ?? 'Error al generar la historia'}
            </p>
          )}
        </div>
      )}

      {/* ─────────────── STEP: PREVIEW ─────────────── */}
      {step === 'preview' && result && (
        <div className="space-y-5">
          <Input label="Nombre de la historia" value={storyName} onChange={(e) => setStoryName(e.target.value)} />

          {result.story.description && (
            <PreviewBlock label="Descripción">{result.story.description}</PreviewBlock>
          )}
          {result.story.globalContext && (
            <PreviewBlock label="Contexto global">{result.story.globalContext}</PreviewBlock>
          )}
          {result.story.worldLore && (
            <PreviewBlock label="Lore del mundo">{result.story.worldLore}</PreviewBlock>
          )}
          {result.story.narrativeRules && (
            <PreviewBlock label="Reglas narrativas">{result.story.narrativeRules}</PreviewBlock>
          )}

          {/* Characters */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-2">
              Personajes ({selected.size}/{result.characters.length} seleccionados)
            </p>
            {result.characters.length === 0 ? (
              <p className="text-xs text-text-muted">El asistente no generó personajes.</p>
            ) : (
              <div className="space-y-2">
                {result.characters.map((c, i) => (
                  <label
                    key={i}
                    className={`flex gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                      selected.has(i) ? 'border-accent bg-accent/10' : 'border-border opacity-60 hover:opacity-100'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={() => toggleChar(i)}
                      className="w-4 h-4 rounded mt-0.5 accent-violet-600 flex-shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">{c.name}</span>
                        {c.role && <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">{c.role}</span>}
                      </div>
                      {c.description && <p className="text-xs text-text-secondary mt-1 leading-relaxed">{c.description}</p>}
                      {c.personality && <p className="text-xs text-text-muted mt-1 leading-relaxed italic">{c.personality}</p>}
                      {c.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {c.tags.map((t) => (
                            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Events + locations summary */}
          <div className="flex items-center gap-4 text-[11px] text-text-muted pt-2 border-t border-border">
            <span className="flex items-center gap-1"><Zap size={11} /> {result.story.events.length} eventos</span>
            <span className="flex items-center gap-1"><MapPin size={11} /> {result.story.locations.length} ubicaciones</span>
          </div>

          {saveMut.isError && (
            <p className="text-xs text-red-400">
              {(saveMut.error as Error)?.message ?? 'Error al guardar'}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── Small helpers ──

function NumberField({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number; onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-text-secondary">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = parseInt(e.target.value);
          if (Number.isNaN(v)) return;
          onChange(Math.min(max, Math.max(min, v)));
        }}
        className="w-full rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
      />
    </div>
  );
}

function ToggleCard({ active, onClick, title, desc }: {
  active: boolean; onClick: () => void; title: string; desc: string;
}) {
  return (
    <div
      onClick={onClick}
      className={`flex items-start gap-2 p-3 rounded-xl border cursor-pointer transition-colors ${
        active ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/40'
      }`}
    >
      <input type="checkbox" checked={active} onChange={onClick} onClick={(e) => e.stopPropagation()}
        className="w-4 h-4 rounded mt-0.5 accent-violet-600 flex-shrink-0" />
      <div>
        <span className={`text-xs font-medium ${active ? 'text-accent' : 'text-text-primary'}`}>{title}</span>
        <p className="text-[11px] text-text-muted mt-0.5 leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

function PreviewBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1.5">{label}</p>
      <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">{children}</p>
    </div>
  );
}
