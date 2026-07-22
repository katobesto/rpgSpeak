import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { storiesApi } from '../../api/stories.ts';
import { charactersApi } from '../../api/characters.ts';
import { Modal } from '../ui/Modal.tsx';
import { Button } from '../ui/Button.tsx';
import { Input, Textarea } from '../ui/Input.tsx';
import { Avatar } from '../ui/Avatar.tsx';
import type { Story, CreateStoryDto, StoryLocation } from '@rpgspeak/shared';
import { CALENDAR_PRESETS, GREGORIAN_CALENDAR } from '@rpgspeak/shared';
import { Plus, Trash2, Search, Wand2, MapPin } from 'lucide-react';

/** crypto.randomUUID() only works in secure contexts (HTTPS / localhost).
 *  When serving from LAN over plain HTTP, fall back to a Math.random UUID v4. */
function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

interface StoryEditorProps {
  story?: Story | null;
  open: boolean;
  onClose: () => void;
}

const DEFAULT_STORY: CreateStoryDto = {
  name: '',
  description: '',
  globalContext: '',
  narrativeRules: '',
  worldLore: '',
  persistentEvents: [],
  locations: [],
  stateVariables: {},
  behaviorRestrictions: [],
  isActive: false,
  adventureMode: false,
  openWorld: false,
  deathMode: false,
  calendar: null,
  characters: [],
};

type TabId = 'basic' | 'context' | 'events' | 'locations' | 'rules' | 'characters';

const TABS: { id: TabId; label: string }[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'context', label: 'Context & Lore' },
  { id: 'events', label: 'Events' },
  { id: 'locations', label: 'Ubicaciones' },
  { id: 'rules', label: 'Rules' },
  { id: 'characters', label: 'Personajes' },
];

export function StoryEditor({ story, open, onClose }: StoryEditorProps) {
  const [tab, setTab] = useState<TabId>('basic');
  const [form, setForm] = useState<CreateStoryDto>(
    story ? { ...DEFAULT_STORY, ...story } : DEFAULT_STORY
  );
  const [newRestriction, setNewRestriction] = useState('');
  const [newVarKey, setNewVarKey] = useState('');
  const [newVarVal, setNewVarVal] = useState('');
  const [charSearch, setCharSearch] = useState('');
  const qc = useQueryClient();

  const { data: allCharacters = [] } = useQuery({
    queryKey: ['characters'],
    queryFn: () => charactersApi.list(),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      story ? storiesApi.update(story.id, form) : storiesApi.create(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stories'] });
      onClose();
    },
  });

  function set<K extends keyof CreateStoryDto>(key: K, value: CreateStoryDto[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const generateEventsMut = useMutation({
    mutationFn: () => {
      if (!story) throw new Error('Guarda la historia antes de generar eventos');
      return storiesApi.generateEvents(story.id, 5);
    },
    onSuccess: (result) => {
      set('persistentEvents', [...form.persistentEvents, ...result.events]);
    },
  });

  const generateLocationsMut = useMutation({
    mutationFn: () => {
      if (!story) throw new Error('Guarda la historia antes de generar ubicaciones');
      return storiesApi.generateLocations(story.id, 5);
    },
    onSuccess: (result) => {
      set('locations', [...(form.locations ?? []), ...result.locations]);
    },
  });

  function addLocation() {
    set('locations', [
      ...(form.locations ?? []),
      { id: randomId(), name: '', description: '', contents: '', exits: '', atmosphere: '' },
    ]);
  }

  function updateLocation(i: number, field: keyof StoryLocation, value: string) {
    const updated = [...(form.locations ?? [])];
    updated[i] = { ...updated[i], [field]: value };
    set('locations', updated);
  }

  function addEvent() {
    set('persistentEvents', [
      ...form.persistentEvents,
      { id: randomId(), title: '', description: '', trigger: '', location: '', timestamp: new Date().toISOString(), importance: 5 },
    ]);
  }

  function updateEvent(i: number, field: string, value: string | number) {
    const updated = [...form.persistentEvents];
    updated[i] = { ...updated[i], [field]: value };
    set('persistentEvents', updated);
  }

  function addRestriction() {
    if (newRestriction.trim()) {
      set('behaviorRestrictions', [...form.behaviorRestrictions, newRestriction.trim()]);
      setNewRestriction('');
    }
  }

  function addStateVar() {
    if (newVarKey.trim()) {
      set('stateVariables', { ...form.stateVariables, [newVarKey.trim()]: newVarVal });
      setNewVarKey('');
      setNewVarVal('');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={story ? `Edit: ${story.name}` : 'New Story'}
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => saveMutation.mutate()} loading={saveMutation.isPending}>
            {story ? 'Save Changes' : 'Create Story'}
          </Button>
        </>
      }
    >
      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-border">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-primary'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {tab === 'basic' && (
          <>
            <Input label="Name *" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Story name" />
            <Textarea label="Description" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Brief description of this story or scenario" rows={3} />
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)}
                className="w-4 h-4 rounded accent-violet-600" />
              <span className="text-sm text-text-secondary">Active by default in new conversations</span>
            </label>
            <div className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
              form.adventureMode ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/40'
            }`} onClick={() => set('adventureMode', !form.adventureMode)}>
              <input
                type="checkbox"
                checked={form.adventureMode ?? false}
                onChange={(e) => set('adventureMode', e.target.checked)}
                className="w-4 h-4 rounded mt-0.5 accent-violet-600 flex-shrink-0"
                onClick={(e) => e.stopPropagation()}
              />
              <div>
                <span className={`text-sm font-medium ${form.adventureMode ? 'text-accent' : 'text-text-primary'}`}>
                  Modo Aventura / RPG
                </span>
                <p className="text-xs text-text-muted mt-0.5">
                  Activa el modo Game Master: la IA narra como GM, gestiona mecánicas RPG y siempre pregunta qué hacer a continuación.
                </p>
              </div>
            </div>
            <div className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
              form.openWorld ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/40'
            }`} onClick={() => set('openWorld', !form.openWorld)}>
              <input
                type="checkbox"
                checked={form.openWorld ?? false}
                onChange={(e) => set('openWorld', e.target.checked)}
                className="w-4 h-4 rounded mt-0.5 accent-violet-600 flex-shrink-0"
                onClick={(e) => e.stopPropagation()}
              />
              <div>
                <span className={`text-sm font-medium ${form.openWorld ? 'text-accent' : 'text-text-primary'}`}>
                  Mundo abierto
                </span>
                <p className="text-xs text-text-muted mt-0.5">
                  Activado: el narrador puede crear ubicaciones nuevas coherentes con el mundo (las registra automáticamente como ubicación de escena).
                  Desactivado: mapa cerrado — solo existen las ubicaciones definidas en la pestaña Ubicaciones.
                </p>
              </div>
            </div>
            <div className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
              form.deathMode ? 'border-red-500/60 bg-red-500/10' : 'border-border hover:border-red-500/40'
            }`} onClick={() => set('deathMode', !form.deathMode)}>
              <input
                type="checkbox"
                checked={form.deathMode ?? false}
                onChange={(e) => set('deathMode', e.target.checked)}
                className="w-4 h-4 rounded mt-0.5 accent-red-600 flex-shrink-0"
                onClick={(e) => e.stopPropagation()}
              />
              <div>
                <span className={`text-sm font-medium ${form.deathMode ? 'text-red-400' : 'text-text-primary'}`}>
                  ☠ Regreso después de la muerte
                </span>
                <p className="text-xs text-text-muted mt-0.5">
                  El jugador puede morir en situaciones letales (combates, trampas, explosiones…). Al morir, la interfaz
                  ofrece regresar a un punto del pasado (la IA elige cuántos mensajes rebobinar, máx. 20) y la historia
                  repite la secuencia fatal — con los personajes sin recuerdos — hasta que consigas sobrevivirla.
                </p>
              </div>
            </div>

            {/* Calendario del mundo — alimenta la cabecera ambiental de cada respuesta */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-secondary">Calendario del mundo</label>
              <select
                value={form.calendar?.name ?? ''}
                onChange={(e) => {
                  const preset = CALENDAR_PRESETS.find((c) => c.name === e.target.value);
                  set('calendar', preset ?? null);
                }}
                className="w-full px-3 py-2 text-sm rounded-lg bg-surface-2 border border-border text-text-primary focus:border-accent outline-none"
              >
                <option value="">Calendario gregoriano (por defecto)</option>
                {CALENDAR_PRESETS.filter((c) => c !== GREGORIAN_CALENDAR).map((c) => (
                  <option key={c.name} value={c.name}>{c.name}</option>
                ))}
              </select>
              <p className="text-xs text-text-muted">
                Define la fecha, la estación y la fase lunar que aparecen en la cabecera al inicio de cada
                respuesta. El reloj lo lleva el servidor: avanza según el tiempo que consume cada escena, así
                que la fecha y la hora nunca se contradicen.
                {form.calendar && (
                  <> Arranca el <strong>{form.calendar.startDay} de {form.calendar.months[form.calendar.startMonth]}
                  {' '}de {form.calendar.startYear}</strong>.</>
                )}
              </p>
            </div>
          </>
        )}

        {tab === 'context' && (
          <>
            <Textarea label="Global Context" value={form.globalContext} onChange={(e) => set('globalContext', e.target.value)}
              placeholder="The overarching scenario context that applies to all conversations using this story..." rows={6} />
            <Textarea label="World Lore" value={form.worldLore} onChange={(e) => set('worldLore', e.target.value)}
              placeholder="World-building, setting details, important places and factions..." rows={6} />
            {/* State Variables */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-secondary">State Variables</label>
              <div className="space-y-1">
                {Object.entries(form.stateVariables).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="text-xs font-mono text-accent w-32 truncate">{k}</span>
                    <span className="text-xs text-text-secondary flex-1">= {String(v)}</span>
                    <button onClick={() => {
                      const rest = Object.fromEntries(Object.entries(form.stateVariables).filter(([key]) => key !== k));
                      set('stateVariables', rest);
                    }} className="text-text-muted hover:text-red-400"><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={newVarKey} onChange={(e) => setNewVarKey(e.target.value)} placeholder="variable_name"
                  className="flex-1 rounded-lg px-3 py-1.5 text-xs bg-surface-2 border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono" />
                <input value={newVarVal} onChange={(e) => setNewVarVal(e.target.value)} placeholder="value"
                  className="flex-1 rounded-lg px-3 py-1.5 text-xs bg-surface-2 border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                <Button size="sm" variant="outline" onClick={addStateVar}><Plus size={12} /></Button>
              </div>
            </div>
          </>
        )}

        {tab === 'events' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {generateEventsMut.isError && (
                  <span className="text-xs text-red-400">
                    {(generateEventsMut.error as Error)?.message ?? 'Error al generar'}
                  </span>
                )}
                {!story && (
                  <span className="text-xs text-text-muted">Guarda la historia primero para generar eventos</span>
                )}
              </div>
              <div className="flex gap-2">
                {story && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => generateEventsMut.mutate()}
                    loading={generateEventsMut.isPending}
                    title="Genera 5 eventos con el LLM principal basándose en el contexto de la historia"
                  >
                    <Wand2 size={13} />
                    {generateEventsMut.isPending ? 'Generando…' : 'Generar con IA'}
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={addEvent}><Plus size={13} /> Add Event</Button>
              </div>
            </div>
            {/* Sugerencias de ubicación para los eventos: las definidas en la pestaña Ubicaciones */}
            <datalist id="story-location-names">
              {form.locations.map((l) => l.name.trim()).filter(Boolean).map((n) => <option key={n} value={n} />)}
            </datalist>
            {form.persistentEvents.map((ev, i) => (
              <div key={ev.id} className="rounded-xl border border-border p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-medium text-text-secondary">Event {i + 1}</span>
                  <button onClick={() => set('persistentEvents', form.persistentEvents.filter((_, idx) => idx !== i))}
                    className="text-text-muted hover:text-red-400"><Trash2 size={13} /></button>
                </div>
                <Input label="Title" value={ev.title} onChange={(e) => updateEvent(i, 'title', e.target.value)} />
                <Input
                  label="Disparador"
                  value={ev.trigger ?? ''}
                  onChange={(e) => updateEvent(i, 'trigger', e.target.value)}
                  placeholder="¿Qué condición activa este evento? (acción del jugador, lugar, tiempo...)"
                />
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-text-secondary">Ubicación</label>
                  <input
                    list="story-location-names"
                    value={ev.location ?? ''}
                    onChange={(e) => updateEvent(i, 'location', e.target.value)}
                    placeholder="¿Dónde ocurre? El narrador guiará al jugador hacia este lugar"
                    className="rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
                <Textarea label="Description" value={ev.description} onChange={(e) => updateEvent(i, 'description', e.target.value)} rows={2} />
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-text-secondary">Importance: {ev.importance}</label>
                  <input type="range" min="1" max="10" value={ev.importance}
                    onChange={(e) => updateEvent(i, 'importance', parseInt(e.target.value))}
                    className="accent-violet-600" />
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'rules' && (
          <>
            <Textarea label="Narrative Rules" value={form.narrativeRules} onChange={(e) => set('narrativeRules', e.target.value)}
              placeholder="How should the narrative flow? What must the AI follow?" rows={5} />
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-secondary">Behavior Restrictions</label>
              <div className="space-y-1">
                {form.behaviorRestrictions.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2">
                    <span className="flex-1 text-xs text-text-primary">{r}</span>
                    <button onClick={() => set('behaviorRestrictions', form.behaviorRestrictions.filter((_, idx) => idx !== i))}
                      className="text-text-muted hover:text-red-400"><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={newRestriction} onChange={(e) => setNewRestriction(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addRestriction(); }}
                  placeholder="e.g. Do not break character"
                  className="flex-1 rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent" />
                <Button size="sm" variant="outline" onClick={addRestriction}><Plus size={13} /></Button>
              </div>
            </div>
          </>
        )}

        {tab === 'characters' && (() => {
          const linkedIds = new Set(form.characters.map((c) => c.characterId));
          const availableChars = allCharacters.filter(
            (c) => !linkedIds.has(c.id) && c.name.toLowerCase().includes(charSearch.toLowerCase())
          );
          return (
            <div className="space-y-5">
              {/* Linked characters */}
              <div>
                <p className="text-xs font-medium text-text-secondary mb-2">
                  Personajes vinculados ({form.characters.length})
                </p>
                {form.characters.length === 0 ? (
                  <div className="text-xs text-text-muted py-5 text-center rounded-xl border border-dashed border-border">
                    No hay personajes vinculados. Agrégalos desde la sección inferior.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {form.characters.map((link, i) => {
                      const char = allCharacters.find((c) => c.id === link.characterId);
                      return (
                        <div key={link.characterId} className="flex items-center gap-3 px-3 py-2 rounded-xl border border-border"
                          style={{ background: 'var(--surface-2)' }}>
                          <Avatar name={char?.name ?? '?'} src={char?.avatar} size="sm" />
                          <span className="text-sm font-medium flex-1 truncate">{char?.name ?? link.characterId}</span>
                          <input
                            value={link.role}
                            onChange={(e) => {
                              const updated = [...form.characters];
                              updated[i] = { ...updated[i], role: e.target.value };
                              set('characters', updated);
                            }}
                            placeholder="Rol (opcional)"
                            className="w-32 rounded-lg px-2 py-1 text-xs border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                            style={{ background: 'var(--surface-1)' }}
                          />
                          <button
                            onClick={() => set('characters', form.characters.filter((_, idx) => idx !== i))}
                            className="text-text-muted hover:text-red-400 flex-shrink-0 transition-colors"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Character picker */}
              <div>
                <p className="text-xs font-medium text-text-secondary mb-2">Agregar personaje</p>
                <div className="relative mb-2">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                  <input
                    value={charSearch}
                    onChange={(e) => setCharSearch(e.target.value)}
                    placeholder="Buscar personajes..."
                    className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                    style={{ background: 'var(--surface-2)' }}
                  />
                </div>
                <div className="max-h-48 overflow-y-auto rounded-xl border border-border divide-y divide-border">
                  {availableChars.length === 0 ? (
                    <p className="text-xs text-text-muted text-center py-4">
                      {linkedIds.size === allCharacters.length
                        ? 'Todos los personajes ya están vinculados'
                        : 'No se encontraron personajes'}
                    </p>
                  ) : (
                    availableChars.map((char) => (
                      <button
                        key={char.id}
                        onClick={() => set('characters', [...form.characters, { characterId: char.id, role: '', notes: '' }])}
                        className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/6 text-left transition-colors"
                      >
                        <Avatar name={char.name} src={char.avatar} size="xs" />
                        <span className="text-sm flex-1 truncate">{char.name}</span>
                        {char.tags.length > 0 && (
                          <span className="text-[10px] text-text-muted truncate max-w-[100px]">{char.tags[0]}</span>
                        )}
                        <Plus size={12} className="text-text-muted flex-shrink-0" />
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {tab === 'locations' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {generateLocationsMut.isError && (
                  <span className="text-xs text-red-400">
                    {(generateLocationsMut.error as Error)?.message ?? 'Error al generar'}
                  </span>
                )}
                {!story && (
                  <span className="text-xs text-text-muted">Guarda la historia primero para generar ubicaciones</span>
                )}
              </div>
              <div className="flex gap-2">
                {story && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => generateLocationsMut.mutate()}
                    loading={generateLocationsMut.isPending}
                    title="Genera 5 ubicaciones con el LLM principal basándose en el contexto de la historia"
                  >
                    <Wand2 size={13} />
                    {generateLocationsMut.isPending ? 'Generando…' : 'Generar con IA'}
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={addLocation}><Plus size={13} /> Añadir</Button>
              </div>
            </div>

            {(form.locations ?? []).length === 0 && !generateLocationsMut.isPending && (
              <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center space-y-2">
                <MapPin size={28} className="text-text-muted mx-auto opacity-40" />
                <p className="text-sm text-text-muted">Sin ubicaciones definidas.</p>
                <p className="text-xs text-text-muted opacity-70">
                  Añade ubicaciones manualmente o usa "Generar con IA". El LLM usará estas tarjetas como referencia espacial y no inventará lugares fuera de ellas.
                </p>
              </div>
            )}

            {(form.locations ?? []).map((loc, i) => (
              <div key={loc.id} className="rounded-xl border border-border p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
                    <MapPin size={11} className="text-accent" /> Ubicación {i + 1}
                  </span>
                  <button
                    onClick={() => set('locations', (form.locations ?? []).filter((_, idx) => idx !== i))}
                    className="text-text-muted hover:text-red-400"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <Input
                  label="Nombre *"
                  value={loc.name}
                  onChange={(e) => updateLocation(i, 'name', e.target.value)}
                  placeholder="ej. Sala del trono, Calabozo norte, Pasillo este"
                />
                <Textarea
                  label="Descripción"
                  value={loc.description}
                  onChange={(e) => updateLocation(i, 'description', e.target.value)}
                  placeholder="Aspecto visual, dimensiones, atmósfera general…"
                  rows={2}
                />
                <Textarea
                  label="Contenido"
                  value={loc.contents}
                  onChange={(e) => updateLocation(i, 'contents', e.target.value)}
                  placeholder="Muebles, objetos, características fijas del lugar…"
                  rows={2}
                />
                <Input
                  label="Salidas"
                  value={loc.exits}
                  onChange={(e) => updateLocation(i, 'exits', e.target.value)}
                  placeholder="ej. puerta sur → corredor este, escalera → piso superior"
                />
                <Input
                  label="Atmósfera"
                  value={loc.atmosphere}
                  onChange={(e) => updateLocation(i, 'atmosphere', e.target.value)}
                  placeholder="Luz, temperatura, olores, sonidos ambientales…"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
