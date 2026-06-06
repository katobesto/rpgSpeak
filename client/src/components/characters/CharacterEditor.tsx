import React, { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { charactersApi } from '../../api/characters.ts';
import { providersApi } from '../../api/providers.ts';
import { Modal } from '../ui/Modal.tsx';
import { Button } from '../ui/Button.tsx';
import { Input, Textarea } from '../ui/Input.tsx';
import { Plus, Trash2, Sword, Sparkles, Image, Star, Loader2, Wand2, Copy, Check } from 'lucide-react';
import type { Character, CreateCharacterDto, RpgStats } from '@rpgspeak/shared';
import { useChatStore } from '../../stores/chat.store.ts';
import { AvatarCropModal } from './AvatarCropModal.tsx';

interface CharacterEditorProps {
  character?: Character | null;
  open: boolean;
  onClose: () => void;
}

const DEFAULT_CHAR: CreateCharacterDto = {
  name: '',
  avatar: null,
  description: '',
  personality: '',
  systemPrompt: '',
  lore: '',
  exampleDialogue: [],
  tags: [],
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

type TabId = 'basic' | 'apariencia' | 'prompt' | 'lore' | 'examples' | 'advanced' | 'rpg';

const TABS: { id: TabId; label: string }[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'apariencia', label: 'Apariencia' },
  { id: 'prompt', label: 'Prompt' },
  { id: 'lore', label: 'Lore' },
  { id: 'examples', label: 'Examples' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'rpg', label: 'RPG' },
];

export function CharacterEditor({ character, open, onClose }: CharacterEditorProps) {
  const [tab, setTab] = useState<TabId>('basic');
  const [form, setForm] = useState<CreateCharacterDto>(
    character
      ? {
          ...DEFAULT_CHAR,
          ...character,
          rpgStats: character.rpgStats ?? {},
          imageDescription: character.imageDescription ?? null,
          gallery: character.gallery ?? [],
        }
      : DEFAULT_CHAR
  );
  const [newAbility, setNewAbility] = useState('');
  const [newInventoryItem, setNewInventoryItem] = useState('');
  const [newStatKey, setNewStatKey] = useState('');
  const [newStatVal, setNewStatVal] = useState('');
  const [generatingDesc, setGeneratingDesc] = useState(false);
  const [descError, setDescError] = useState<string | null>(null);
  const [descCopied, setDescCopied] = useState(false);

  function copyImageDesc() {
    const text = form.imageDescription?.trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setDescCopied(true);
      setTimeout(() => setDescCopied(false), 1500);
    });
  }
  const [generatingComfy, setGeneratingComfy] = useState(false);
  const [comfyError, setComfyError] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  // Provider/modelo seleccionado en la sesión de chat (como fallback para generar descripción)
  const { selectedProviderId, selectedModelId } = useChatStore();

  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: providersApi.list,
  });

  const selectedProvider = providers.find((p) => p.id === form.providerId);

  const { data: models = [] } = useQuery({
    queryKey: ['provider-models', form.providerId],
    queryFn: () => providersApi.listModels(form.providerId!),
    enabled: !!form.providerId,
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      character ? charactersApi.update(character.id, form) : charactersApi.create(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['characters'] });
      onClose();
    },
    onError: (err) => {
      setSaveError(err instanceof Error ? err.message : 'Error al guardar');
    },
  });

  function set<K extends keyof CreateCharacterDto>(key: K, value: CreateCharacterDto[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setRpg<K extends keyof RpgStats>(key: K, value: RpgStats[K]) {
    setForm((f) => ({ ...f, rpgStats: { ...(f.rpgStats ?? {}), [key]: value } }));
  }

  function addAbility() {
    if (newAbility.trim()) {
      setRpg('abilities', [...(form.rpgStats?.abilities ?? []), newAbility.trim()]);
      setNewAbility('');
    }
  }

  function addInventoryItem() {
    if (newInventoryItem.trim()) {
      setRpg('inventory', [...(form.rpgStats?.inventory ?? []), newInventoryItem.trim()]);
      setNewInventoryItem('');
    }
  }

  function addStat() {
    if (newStatKey.trim()) {
      const val = parseFloat(newStatVal) || 0;
      setRpg('stats', { ...(form.rpgStats?.stats ?? {}), [newStatKey.trim()]: val });
      setNewStatKey('');
      setNewStatVal('');
    }
  }

  function addExample() {
    set('exampleDialogue', [...form.exampleDialogue, { user: '', assistant: '' }]);
  }

  function updateExample(i: number, field: 'user' | 'assistant', value: string) {
    const updated = [...form.exampleDialogue];
    updated[i] = { ...updated[i], [field]: value };
    set('exampleDialogue', updated);
  }

  function removeExample(i: number) {
    set('exampleDialogue', form.exampleDialogue.filter((_, idx) => idx !== i));
  }

  function addTag(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = (e.currentTarget.value ?? '').trim();
      if (val && !form.tags.includes(val)) set('tags', [...form.tags, val]);
      e.currentTarget.value = '';
    }
  }

  async function handleGenerateComfyImage() {
    if (!character?.id) return;
    setGeneratingComfy(true);
    setComfyError(null);
    try {
      const updated = await charactersApi.generateComfyImage(character.id);
      set('gallery', updated.gallery ?? []);
      if (!form.avatar && updated.avatar) set('avatar', updated.avatar);
      qc.invalidateQueries({ queryKey: ['characters'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      setComfyError(msg);
    } finally {
      setGeneratingComfy(false);
    }
  }

  async function handleGenerateDescription() {
    if (!character?.id) return;
    setGeneratingDesc(true);
    setDescError(null);
    try {
      const result = await charactersApi.generateImageDescription(character.id, {
        // Pasa el provider/modelo activo en la sesión como override si el personaje no tiene uno propio
        providerId: form.providerId ?? selectedProviderId ?? undefined,
        modelId: form.modelId ?? selectedModelId ?? undefined,
      });
      set('imageDescription', result.description);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      setDescError(msg);
    } finally {
      setGeneratingDesc(false);
    }
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!character?.id) return;
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';

    setUploadingImage(true);
    setUploadError(null);

    try {
      const updated = await charactersApi.addImage(character.id, file);
      set('gallery', updated.gallery ?? []);
      if (updated.avatar) set('avatar', updated.avatar);
      qc.invalidateQueries({ queryKey: ['characters'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al subir la imagen';
      setUploadError(msg);
    } finally {
      setUploadingImage(false);
    }
  }

  async function handleRemoveImage(imagePath: string) {
    if (!character?.id) return;
    try {
      const updated = await charactersApi.removeImage(character.id, imagePath);
      set('gallery', updated.gallery ?? []);
      if (form.avatar === imagePath) set('avatar', updated.avatar);
      qc.invalidateQueries({ queryKey: ['characters'] });
    } catch (err) {
      console.error('Error removing image:', err);
    }
  }

  async function handleCropConfirm(blob: Blob) {
    if (!character?.id) return;
    // Convert blob to File so addImage can upload it
    const croppedFile = new File([blob], 'avatar-crop.jpg', { type: 'image/jpeg' });
    setUploadingImage(true);
    try {
      // Upload the cropped image and set it directly as avatar
      const updated = await charactersApi.addImage(character.id, croppedFile, true);
      set('gallery', updated.gallery ?? []);
      set('avatar', updated.avatar);
      qc.invalidateQueries({ queryKey: ['characters'] });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Error al guardar el recorte');
    } finally {
      setUploadingImage(false);
      setCropSrc(null);
    }
  }

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title={character ? `Edit: ${character.name}` : 'New Character'}
      size="xl"
      footer={
        <>
          {saveError && (
            <span className="text-xs text-red-400 mr-auto">{saveError}</span>
          )}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { setSaveError(null); saveMutation.mutate(); }} loading={saveMutation.isPending}>
            {character ? 'Save Changes' : 'Create Character'}
          </Button>
        </>
      }
    >
      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-border pb-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? 'border-accent text-accent'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {tab === 'basic' && (
          <>
            <Input label="Name *" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Character name" />
            <Textarea label="Description" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Short description of the character" rows={3} />
            <Textarea label="Personality" value={form.personality} onChange={(e) => set('personality', e.target.value)} placeholder="Personality traits, speech patterns, mannerisms..." rows={4} />
            {/* Tags */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-text-secondary">Tags</label>
              <div className="flex flex-wrap gap-1.5 mb-1">
                {form.tags.map((tag) => (
                  <span key={tag} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-accent-muted text-accent">
                    {tag}
                    <button onClick={() => set('tags', form.tags.filter((t) => t !== tag))}>
                      <Trash2 size={10} />
                    </button>
                  </span>
                ))}
              </div>
              <input
                placeholder="Type tag and press Enter"
                onKeyDown={addTag}
                className="w-full rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          </>
        )}

        {tab === 'apariencia' && (
          <div className="space-y-5">
            {/* Image description section */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-text-secondary">Descripción para generador de imágenes</label>
                {form.imageDescription?.trim() && (
                  <button
                    onClick={copyImageDesc}
                    className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
                    title="Copiar prompt"
                  >
                    {descCopied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                    {descCopied ? 'Copiado' : 'Copiar'}
                  </button>
                )}
              </div>
              <Textarea
                value={form.imageDescription ?? ''}
                onChange={(e) => set('imageDescription', e.target.value || null)}
                placeholder="Un prompt detallado en inglés que describa la apariencia física del personaje para usar en Stable Diffusion, Midjourney o DALL-E..."
                rows={6}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleGenerateDescription}
                  loading={generatingDesc}
                  disabled={generatingDesc || generatingComfy || !character?.id}
                >
                  {generatingDesc ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Sparkles size={13} />
                  )}
                  {generatingDesc ? 'Generando...' : 'Generar con IA'}
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleGenerateComfyImage}
                  loading={generatingComfy}
                  disabled={generatingDesc || generatingComfy || !character?.id || !form.imageDescription?.trim()}
                  title={!form.imageDescription?.trim() ? 'Escribe o genera primero la descripción de imagen' : 'Generar imagen con ComfyUI'}
                >
                  {generatingComfy ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Wand2 size={13} />
                  )}
                  {generatingComfy ? 'Generando imagen...' : 'Generar imagen'}
                </Button>
              </div>

              {!character?.id && (
                <p className="text-[11px] text-text-muted">Guarda el personaje primero para usar la generación con IA.</p>
              )}
              {descError && (
                <p className="text-[11px] text-red-400">{descError}</p>
              )}
              {comfyError && (
                <p className="text-[11px] text-red-400">ComfyUI: {comfyError}</p>
              )}
            </div>

            {/* Gallery section */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-text-secondary">Galería de imágenes</label>
                <div className="flex items-center gap-2">
                  {uploadingImage && <Loader2 size={12} className="animate-spin text-text-muted" />}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!character?.id || uploadingImage}
                  >
                    <Image size={13} /> Subir imagen
                  </Button>
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageUpload}
              />

              {!character?.id && (
                <p className="text-[11px] text-text-muted">Guarda el personaje primero para subir imágenes.</p>
              )}
              {uploadError && (
                <p className="text-[11px] text-red-400">{uploadError}</p>
              )}

              {(form.gallery ?? []).length === 0 && character?.id && (
                <p className="text-[11px] text-text-muted italic">Sin imágenes aún. Sube una imagen para empezar.</p>
              )}

              {(form.gallery ?? []).length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {(form.gallery ?? []).map((imgPath) => (
                    <div
                      key={imgPath}
                      className={`relative aspect-square rounded-xl overflow-hidden border-2 transition-colors ${
                        form.avatar === imgPath ? 'border-accent' : 'border-border'
                      }`}
                    >
                      <img
                        src={imgPath}
                        alt="Gallery"
                        className="w-full h-full object-cover"
                      />
                      {/* Hover overlay */}
                      <div className="absolute inset-0 bg-black/60 opacity-0 hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2">
                        <button
                          onClick={() => setCropSrc(imgPath)}
                          className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] bg-accent/80 text-white hover:bg-accent transition-colors"
                        >
                          <Star size={11} /> Avatar
                        </button>
                        <button
                          onClick={() => handleRemoveImage(imgPath)}
                          className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] bg-red-500/70 text-white hover:bg-red-500 transition-colors"
                        >
                          <Trash2 size={11} /> Eliminar
                        </button>
                      </div>
                      {/* Primary badge */}
                      {form.avatar === imgPath && (
                        <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded-md text-[10px] bg-accent text-white font-medium">
                          Avatar
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'prompt' && (
          <>
            <Textarea
              label="System Prompt"
              value={form.systemPrompt}
              onChange={(e) => set('systemPrompt', e.target.value)}
              placeholder="You are {{name}}. Describe how this character should behave..."
              rows={10}
              hint="Main instruction that defines this character's behavior and role."
            />
          </>
        )}

        {tab === 'lore' && (
          <Textarea
            label="Lore & Background"
            value={form.lore}
            onChange={(e) => set('lore', e.target.value)}
            placeholder="Background story, world information, history..."
            rows={12}
          />
        )}

        {tab === 'examples' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-text-muted">Example dialogues help the model understand the character's voice.</p>
              <Button size="sm" variant="outline" onClick={addExample}>
                <Plus size={13} /> Add Example
              </Button>
            </div>
            {form.exampleDialogue.map((ex, i) => (
              <div key={i} className="rounded-xl border border-border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-text-secondary">Example {i + 1}</span>
                  <button onClick={() => removeExample(i)} className="text-text-muted hover:text-red-400 transition-colors">
                    <Trash2 size={13} />
                  </button>
                </div>
                <Textarea label="User" value={ex.user} onChange={(e) => updateExample(i, 'user', e.target.value)} rows={2} />
                <Textarea label="Character" value={ex.assistant} onChange={(e) => updateExample(i, 'assistant', e.target.value)} rows={3} />
              </div>
            ))}
          </div>
        )}

        {tab === 'rpg' && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <Sword size={14} className="text-accent" />
              <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Ficha RPG</span>
            </div>

            {/* Clase + Nivel */}
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Clase"
                value={form.rpgStats?.class ?? ''}
                onChange={(e) => setRpg('class', e.target.value || undefined)}
                placeholder="Guerrero"
              />
              <Input
                label="Nivel"
                type="number"
                value={form.rpgStats?.level ?? ''}
                onChange={(e) => setRpg('level', e.target.value ? parseInt(e.target.value, 10) : undefined)}
                min={1}
                max={20}
                placeholder="1"
              />
            </div>

            {/* HP actual + HP máximo */}
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="HP actual"
                type="number"
                value={form.rpgStats?.hp ?? ''}
                onChange={(e) => setRpg('hp', e.target.value ? parseFloat(e.target.value) : undefined)}
                placeholder="20"
              />
              <Input
                label="HP máximo"
                type="number"
                value={form.rpgStats?.maxHp ?? ''}
                onChange={(e) => setRpg('maxHp', e.target.value ? parseFloat(e.target.value) : undefined)}
                placeholder="20"
              />
            </div>

            {/* Stats */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-secondary">Stats</label>
              <div className="space-y-1">
                {Object.entries(form.rpgStats?.stats ?? {}).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="text-xs font-mono text-accent w-24 truncate">{k}</span>
                    <span className="text-xs text-text-secondary flex-1">{v}</span>
                    <button
                      onClick={() => {
                        const { [k]: _, ...rest } = form.rpgStats?.stats ?? {};
                        setRpg('stats', rest);
                      }}
                      className="text-text-muted hover:text-red-400"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
                {Object.keys(form.rpgStats?.stats ?? {}).length === 0 && (
                  <p className="text-xs text-text-muted italic">Sugerencias: Fuerza, Destreza, Magia, Carisma</p>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  value={newStatKey}
                  onChange={(e) => setNewStatKey(e.target.value)}
                  placeholder="Fuerza"
                  className="flex-1 rounded-lg px-3 py-1.5 text-xs bg-surface-2 border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                />
                <input
                  value={newStatVal}
                  onChange={(e) => setNewStatVal(e.target.value)}
                  placeholder="10"
                  type="number"
                  className="w-20 rounded-lg px-3 py-1.5 text-xs bg-surface-2 border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <button
                  onClick={addStat}
                  className="px-2 py-1.5 rounded-lg text-xs border border-border text-text-muted hover:text-text-primary hover:border-accent/40 transition-colors"
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>

            {/* Habilidades */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-secondary">Habilidades</label>
              <div className="space-y-1">
                {(form.rpgStats?.abilities ?? []).map((a, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2">
                    <span className="flex-1 text-xs text-text-primary">{a}</span>
                    <button
                      onClick={() => setRpg('abilities', (form.rpgStats?.abilities ?? []).filter((_, idx) => idx !== i))}
                      className="text-text-muted hover:text-red-400"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={newAbility}
                  onChange={(e) => setNewAbility(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addAbility(); }}
                  placeholder="ej. Golpe certero"
                  className="flex-1 rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <button
                  onClick={addAbility}
                  className="px-3 py-2 rounded-lg text-xs border border-border text-text-muted hover:text-text-primary hover:border-accent/40 transition-colors"
                >
                  <Plus size={13} />
                </button>
              </div>
            </div>

            {/* Inventario */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-secondary">Inventario</label>
              <div className="space-y-1">
                {(form.rpgStats?.inventory ?? []).map((item, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2">
                    <span className="flex-1 text-xs text-text-primary">{item}</span>
                    <button
                      onClick={() => setRpg('inventory', (form.rpgStats?.inventory ?? []).filter((_, idx) => idx !== i))}
                      className="text-text-muted hover:text-red-400"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={newInventoryItem}
                  onChange={(e) => setNewInventoryItem(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addInventoryItem(); }}
                  placeholder="ej. Espada larga +1"
                  className="flex-1 rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <button
                  onClick={addInventoryItem}
                  className="px-3 py-2 rounded-lg text-xs border border-border text-text-muted hover:text-text-primary hover:border-accent/40 transition-colors"
                >
                  <Plus size={13} />
                </button>
              </div>
            </div>

            {/* Notas de ficha */}
            <Textarea
              label="Notas de ficha"
              value={form.rpgStats?.notes ?? ''}
              onChange={(e) => setRpg('notes', e.target.value || undefined)}
              placeholder="Trasfondo especial, condiciones activas, maldiciones..."
              rows={3}
            />
          </div>
        )}

        {tab === 'advanced' && (
          <div className="space-y-4">
            {/* Provider + Model */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-text-secondary">Provider</label>
                <select
                  value={form.providerId ?? ''}
                  onChange={(e) => { set('providerId', e.target.value || null); set('modelId', null); }}
                  className="rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  <option value="">Use default</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-text-secondary">Model</label>
                <select
                  value={form.modelId ?? ''}
                  onChange={(e) => set('modelId', e.target.value || null)}
                  className="rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  disabled={!form.providerId}
                >
                  <option value="">Use provider default</option>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            </div>

            {/* Temperature */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-text-secondary">
                Temperature <span className="text-accent">{form.temperature.toFixed(1)}</span>
              </label>
              <input
                type="range" min="0" max="2" step="0.1"
                value={form.temperature}
                onChange={(e) => set('temperature', parseFloat(e.target.value))}
                className="w-full accent-violet-600"
              />
              <div className="flex justify-between text-[10px] text-text-muted">
                <span>Precise (0)</span><span>Balanced (1)</span><span>Creative (2)</span>
              </div>
            </div>

            {/* Context length */}
            <Input
              label="Context Length (tokens)"
              type="number"
              value={form.contextLength}
              onChange={(e) => set('contextLength', parseInt(e.target.value, 10))}
              min={512} max={131072}
              hint="Maximum context window for this character."
            />

            {/* Memory */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-text-secondary">Memory Type</label>
                <select
                  value={form.memoryType}
                  onChange={(e) => set('memoryType', e.target.value as Character['memoryType'])}
                  className="rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  <option value="rolling">Rolling window</option>
                  <option value="summary">Summarized</option>
                  <option value="none">Disabled</option>
                </select>
              </div>
              <Input
                label="Memory Window"
                type="number"
                value={form.memoryWindow}
                onChange={(e) => set('memoryWindow', parseInt(e.target.value, 10))}
                min={1} max={200}
                hint="Number of messages to remember."
              />
            </div>
          </div>
        )}
      </div>
    </Modal>

    {cropSrc && (
      <AvatarCropModal
        imageSrc={cropSrc}
        onConfirm={handleCropConfirm}
        onClose={() => setCropSrc(null)}
      />
    )}
    </>
  );
}
