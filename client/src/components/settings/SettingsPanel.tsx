import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../../api/settings.ts';
import { providersApi } from '../../api/providers.ts';
import { ttsApi } from '../../api/tts.ts';
import { getAuthHeader } from '../../api/client.ts';
import { usersApi, authApi } from '../../api/auth.ts';
import { charactersApi } from '../../api/characters.ts';
import { storiesApi } from '../../api/stories.ts';
import { Button } from '../ui/Button.tsx';
import { Input, Textarea } from '../ui/Input.tsx';
import { Plus, Trash2, RefreshCw, Check, X, Volume2, Wifi, Download, CheckCircle2, Play, Square, Loader, LogOut, Users, Shield, UserCircle, RotateCcw, AlertCircle, BarChart2, Zap, Camera, Sparkles, Wand2, FlaskConical, Upload, Link2, BookOpen, Pencil, DatabaseBackup, HardDriveDownload, HardDriveUpload, TriangleAlert } from 'lucide-react';
import { backupApi } from '../../api/backup.ts';
import type { Provider, CreateProviderDto, AppSettings, TtsSettings, TtsVoice, BzWorkflow } from '@rpgspeak/shared';
import { useUiStore } from '../../stores/ui.store.ts';
import { useAuthStore } from '../../stores/auth.store.ts';
import { conversationsApi } from '../../api/conversations.ts';
import { AvatarCropModal } from '../characters/AvatarCropModal.tsx';

type STab = 'appearance' | 'generation' | 'providers' | 'context' | 'voice' | 'users' | 'profile' | 'stats' | 'backup';

const GENERATION_KEYS:    (keyof AppSettings)[] = ['defaultProviderId', 'defaultModelId', 'sendOnEnter', 'streamingEnabled', 'globalSystemPrompt', 'responseFormatPrompt', 'narratorPrompt', 'sceneImagePrompt', 'charImagePrompt', 'backgroundImagePrompt', 'fastLlmEnabled', 'fastLlmProviderId', 'fastLlmModelId', 'fastLlmDebugMode', 'fastLlmAnalysisPrompt', 'affinitySystemPrompt', 'memoryInjectionPrompt', 'embeddingEnabled', 'embeddingProviderId', 'embeddingModel', 'contextIndexInjectionEnabled', 'contextIndexInjectionMaxItems', 'contextIndexInjectionPrompt', 'contextIndexPrompt', 'contextIndexContextSize', 'contextAutoExtractEnabled', 'contextAutoExtractInterval', 'contextAutoExtractProviderId', 'contextAutoExtractModelId', 'storyEventGenerationPrompt', 'storyLocationGenerationPrompt', 'narrationMediumPrompt', 'narrationShortPrompt', 'allowNsfw', 'nsfwBlockedMessage', 'summaryMaxLength', 'disableFallbacks', 'reasoningEnabled', 'reasoningEffort'];
const CONTEXT_KEYS:       (keyof AppSettings)[] = ['contextStrategy', 'maxContextMessages', 'autoSummarizeThreshold', 'maxResponseTokens', 'defaultContextLength'];
const INTEGRATIONS_KEYS:  (keyof AppSettings)[] = ['comfyUiUrl', 'imageProvider', 'imageProviderApiKey', 'pollinationsModel', 'geminiModel', 'falModel', 'comfyUiCfClientId', 'comfyUiCfClientSecret', 'bzComfyUrl', 'bzComfyApiToken', 'bzComfyWorkflow'];

export function SettingsPanel() {
  const [tab, setTab] = useState<STab>('profile');
  const [genTab, setGenTab] = useState<'llm' | 'fast-llm' | 'embeddings' | 'images'>('llm');
  const qc = useQueryClient();
  const { appearance, setAppearancePref } = useUiStore();
  const { user: currentUser, isAdmin, clearAuth } = useAuthStore();

  const STABS: { id: STab; label: string }[] = [
    { id: 'profile', label: 'Perfil' },
    { id: 'appearance', label: 'Preferencias' },
    ...(isAdmin ? [
      { id: 'generation' as STab, label: 'Generación' },
      { id: 'context' as STab, label: 'Contexto' },
      { id: 'providers' as STab, label: 'Providers' },
      { id: 'voice' as STab, label: 'Voz / TTS' },
      { id: 'stats' as STab, label: 'Estadísticas' },
      { id: 'users' as STab, label: 'Usuarios' },
      { id: 'backup' as STab, label: 'Copia de seguridad' },
    ] : []),
  ];

  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const { data: providers = [] } = useQuery({ queryKey: ['providers'], queryFn: providersApi.list });

  // Local draft — avoids cursor-jump on text inputs; saved explicitly via "Guardar"
  const [draft, setDraft] = useState<AppSettings | null>(null);
  useEffect(() => {
    if (settings && draft === null) setDraft({ ...settings });
  }, [settings]);

  const updateSettings = useMutation({
    mutationFn: (data: Partial<AppSettings>) => settingsApi.update(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  // Update draft locally without saving to server
  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setDraft((d) => d ? { ...d, [key]: value } : d);
  }

  // Save a subset of draft keys to the server
  function save(keys: (keyof AppSettings)[]) {
    if (!draft) return;
    const patch: Partial<AppSettings> = {};
    for (const k of keys) (patch as Record<string, unknown>)[k] = draft[k];
    updateSettings.mutate(patch);
  }

  if (!settings || !draft) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 px-6 py-4 border-b border-border">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold">Settings</h1>
            <p className="text-xs text-text-muted mt-0.5">Configure your rpgSpeak experience</p>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <div className="text-right">
              <p className="text-sm font-medium text-text-primary leading-tight">
                {currentUser?.displayName}
              </p>
              <p className="text-xs text-text-muted leading-tight flex items-center gap-1 justify-end">
                {isAdmin && <Shield size={10} className="text-accent" />}
                {currentUser?.username}
              </p>
            </div>
            <button
              onClick={clearAuth}
              title="Cerrar sesión"
              className="p-1.5 rounded-lg text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Tab nav */}
        <nav className="w-40 flex-shrink-0 border-r border-border p-3 space-y-0.5">
          {STABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                tab === t.id ? 'bg-accent-muted text-accent font-medium' : 'text-text-secondary hover:text-text-primary hover:bg-white/5'
              }`}>
              {t.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {tab === 'profile' && <ProfileSection />}

          {tab === 'appearance' && (
            <>
              <NarrationStyleSection />

              <Section title="Tema">
                <div className="flex gap-2">
                  {(['dark', 'light'] as const).map((t) => (
                    <button key={t} onClick={() => setAppearancePref('theme', t)}
                      className={`flex-1 py-2 rounded-lg text-sm capitalize border transition-colors ${
                        appearance.theme === t
                          ? 'border-accent bg-accent-muted text-accent'
                          : 'border-border text-text-secondary hover:border-accent/40'
                      }`}>
                      {t === 'dark' ? 'Oscuro' : 'Claro'}
                    </button>
                  ))}
                </div>
              </Section>

              <Section title="Color de acento">
                <div className="flex items-center gap-3">
                  <input type="color" value={appearance.accentColor}
                    onChange={(e) => setAppearancePref('accentColor', e.target.value)}
                    className="w-10 h-10 rounded-lg border-0 cursor-pointer bg-transparent" />
                  <Input value={appearance.accentColor} onChange={(e) => setAppearancePref('accentColor', e.target.value)} className="font-mono text-xs" />
                </div>
              </Section>

              <Section title="Tamaño de fuente">
                <div className="flex gap-2">
                  {(['sm', 'md', 'lg'] as const).map((s) => (
                    <button key={s} onClick={() => setAppearancePref('fontSize', s)}
                      className={`flex-1 py-2 rounded-lg text-sm border transition-colors ${
                        appearance.fontSize === s ? 'border-accent bg-accent-muted text-accent' : 'border-border text-text-secondary hover:border-accent/40'
                      }`}>
                      {s === 'sm' ? 'Pequeño' : s === 'md' ? 'Normal' : 'Grande'}
                    </button>
                  ))}
                </div>
              </Section>

              <Section title="Interfaz">
                <ToggleRow
                  label="Mostrar hora" description="Muestra la hora de cada mensaje"
                  checked={appearance.showTimestamps} onChange={(v) => setAppearancePref('showTimestamps', v)} />
                <ToggleRow
                  label="Mostrar tokens" description="Muestra el conteo de tokens por mensaje"
                  checked={appearance.showTokenCount} onChange={(v) => setAppearancePref('showTokenCount', v)} />
              </Section>
              <p className="text-xs text-text-muted text-right">Los cambios se guardan automáticamente.</p>
            </>
          )}

          {tab === 'generation' && isAdmin && (
            <>
              {/* ── Sub-tab bar ─────────────────────────────────────────────────── */}
              <div className="flex gap-1 border-b border-border pb-3 -mt-2 mb-5">
                {([
                  { id: 'llm',        label: 'LLM Principal' },
                  { id: 'fast-llm',   label: 'LLM Rápido' },
                  { id: 'embeddings', label: 'Embeddings' },
                  { id: 'images',     label: 'Generación de imágenes' },
                ] as const).map((t) => (
                  <button key={t.id} onClick={() => setGenTab(t.id)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      genTab === t.id
                        ? 'bg-accent-muted text-accent'
                        : 'text-text-muted hover:text-text-primary hover:bg-white/5'
                    }`}>
                    {t.label}
                  </button>
                ))}
              </div>

              {/* ══ LLM Principal ════════════════════════════════════════════════ */}
              {genTab === 'llm' && (
                <>
                  <p className="text-xs text-text-muted leading-relaxed -mt-2 mb-5 pb-3 border-b border-border/50">
                    El <strong className="text-text-secondary">motor principal</strong> de la historia.
                    Recibe el historial completo de la conversación y genera las respuestas de los personajes.
                    Configura aquí el modelo base, los prompts de personaje y todas las inyecciones de contexto.
                  </p>

                  <Section title="Modelo por defecto">
                    <p className="text-xs text-text-muted mb-2 leading-relaxed">
                      Provider y modelo usados cuando el personaje no tiene configuración propia.
                    </p>
                    <DefaultModelSection
                      providers={providers}
                      defaultProviderId={draft.defaultProviderId}
                      defaultModelId={draft.defaultModelId}
                      onProviderChange={(v) => update('defaultProviderId', v)}
                      onModelChange={(v) => update('defaultModelId', v)}
                      hideDescription
                    />
                  </Section>

                  <Section title="Entrada">
                    <ToggleRow
                      label="Enter para enviar" description="Enter envía el mensaje; Shift+Enter para nueva línea"
                      checked={draft.sendOnEnter} onChange={(v) => update('sendOnEnter', v)} />
                    <ToggleRow
                      label="Streaming" description="Muestra los tokens según se generan"
                      checked={draft.streamingEnabled} onChange={(v) => update('streamingEnabled', v)} />
                  </Section>

                  <Section title="Resúmenes de sucesos">
                    <Input
                      label="Longitud máxima de resumen (frases)"
                      type="number"
                      value={draft.summaryMaxLength ?? 5}
                      onChange={(e) => update('summaryMaxLength', Math.max(1, parseInt(e.target.value) || 5))}
                      min={1}
                      max={20}
                      hint="Número máximo de frases en cada resumen generado automáticamente o bajo demanda (1–20)."
                    />
                  </Section>

                  <Section title="Opciones de API">
                    <ToggleRow
                      label="Deshabilitar fallbacks de proveedor"
                      description="Envía allow_fallbacks:false en cada petición. Evita que OpenRouter redirija a servidores alternativos de pago cuando el modelo principal no está disponible."
                      checked={draft.disableFallbacks ?? false}
                      onChange={(v) => update('disableFallbacks', v)}
                    />
                    <ToggleRow
                      label="Razonamiento (thinking) en el modelo principal"
                      description="Activa el modo thinking (p.ej. DeepSeek V4: thinking:enabled + reasoning_effort). Mejora la coherencia y el seguimiento de detalles (objetos, ubicaciones), pero aumenta la latencia y el coste por respuesta. Solo funciona con modelos que soporten este modo."
                      checked={draft.reasoningEnabled ?? false}
                      onChange={(v) => update('reasoningEnabled', v)}
                    />
                    {draft.reasoningEnabled && (
                      <div className="mt-2">
                        <label className="block text-sm font-medium text-text-secondary mb-1">Nivel de esfuerzo</label>
                        <select
                          className="w-full px-3 py-2 rounded-lg bg-surface-2 border border-border text-sm text-text-primary"
                          value={draft.reasoningEffort ?? 'high'}
                          onChange={(e) => update('reasoningEffort', e.target.value as AppSettings['reasoningEffort'])}
                        >
                          <option value="high">Alto</option>
                          <option value="max">Máximo</option>
                        </select>
                      </div>
                    )}
                  </Section>

                  <Section title="Prompt de sistema global">
                    <p className="text-xs text-text-muted mb-1 leading-relaxed">
                      <span className="text-accent/70 font-mono text-[10px] mr-1">[SYSTEM]</span>
                      <strong className="text-text-secondary">Primer mensaje</strong> de la petición, antes del prompt de personaje. Se aplica a todos los personajes y conversaciones.
                    </p>
                    <RestorablePrompt
                      settingsKey="globalSystemPrompt"
                      value={draft.globalSystemPrompt ?? ''}
                      onChange={(v) => update('globalSystemPrompt', v)}
                      rows={5}
                      mono
                    />
                  </Section>

                  <Section title="Formato de respuesta (personaje)">
                    <p className="text-xs text-text-muted mb-1 leading-relaxed">
                      <span className="text-accent/70 font-mono text-[10px] mr-1">[SYSTEM]</span>
                      Se añade <strong className="text-text-secondary">al final del prompt del personaje</strong>. Fuerza un estilo de respuesta concreto (sin asteriscos, tercera persona, longitud, etc.). Vacío = sin formato forzado.
                    </p>
                    <RestorablePrompt
                      settingsKey="responseFormatPrompt"
                      value={draft.responseFormatPrompt ?? ''}
                      onChange={(v) => update('responseFormatPrompt', v)}
                      rows={5}
                    />
                  </Section>

                  <Section title="Prompt del Narrador">
                    <p className="text-xs text-text-muted mb-1 leading-relaxed">
                      <span className="text-accent/70 font-mono text-[10px] mr-1">[SYSTEM]</span>
                      Reemplaza el prompt de personaje cuando el modo <strong className="text-text-secondary">Narrador</strong> está activo (sin aventura).
                      Usa <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'{{PERSONAJES}}'}</code> donde insertar los bloques de personaje.
                    </p>
                    <RestorablePrompt
                      settingsKey="narratorPrompt"
                      value={draft.narratorPrompt ?? ''}
                      onChange={(v) => update('narratorPrompt', v)}
                      rows={14}
                      mono
                    />
                  </Section>

                  <Section title="Prompt de inyección de memoria">
                    <p className="text-xs text-text-muted mb-1 leading-relaxed">
                      <span className="text-accent/70 font-mono text-[10px] mr-1">[SYSTEM]</span>
                      Se inserta <strong className="text-text-secondary">justo antes del último mensaje del usuario</strong>, después del índice de contexto (si está activo).
                      Usa <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'{{MEMORIAS}}'}</code> donde aparecerá el bloque de recuerdos. Vacío = sin inyección.
                    </p>
                    <RestorablePrompt
                      settingsKey="memoryInjectionPrompt"
                      value={draft.memoryInjectionPrompt ?? ''}
                      onChange={(v) => update('memoryInjectionPrompt', v)}
                      rows={8}
                      mono
                    />
                  </Section>

                  <Section title="Inyección del Índice de Contexto">
                    <p className="text-xs text-text-muted mb-2 leading-relaxed">
                      <span className="text-accent/70 font-mono text-[10px] mr-1">[SYSTEM]</span>
                      Selecciona los ítems más relevantes del índice e inyecta un bloque de sistema <strong className="text-text-secondary">antes de las memorias y el último mensaje</strong>.
                      Con embeddings activos (pestaña Embeddings) la relevancia es semántica; sin ellos, usa importancia + recencia + palabras clave.
                      Usa{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'{{CONTEXTO}}'}</code>{' '}
                      donde aparecerá el bloque agrupado por tipo.
                    </p>
                    <ToggleRow
                      label="Activar inyección de contexto"
                      description="Requiere que el Índice de Contexto esté generado para la conversación."
                      checked={draft.contextIndexInjectionEnabled ?? false}
                      onChange={(v) => update('contextIndexInjectionEnabled', v)}
                    />
                    {(draft.contextIndexInjectionEnabled) && (
                      <div className="mt-3 space-y-3">
                        <Input
                          label="Número máximo de ítems"
                          type="number"
                          value={draft.contextIndexInjectionMaxItems ?? 10}
                          onChange={(e) => update('contextIndexInjectionMaxItems', parseInt(e.target.value) || 10)}
                          min={1}
                          max={50}
                          hint="Entre 8 y 15 es un buen equilibrio. Más ítems = más tokens consumidos."
                        />
                        <RestorablePrompt
                          settingsKey="contextIndexInjectionPrompt"
                          value={draft.contextIndexInjectionPrompt ?? ''}
                          onChange={(v) => update('contextIndexInjectionPrompt', v)}
                          rows={8}
                          mono
                        />
                      </div>
                    )}
                  </Section>

                  <Section title="Prompt de generación de eventos (Historia)">
                    <p className="text-xs text-text-muted mb-1 leading-relaxed">
                      Prompt que usa el LLM principal cuando pulsas <strong className="text-text-secondary">Generar con IA</strong> en el editor de historias.
                      Usa{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'{{NUM_EVENTOS}}'}</code>{' '}
                      para el número de eventos y{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'{{CONTEXTO_HISTORIA}}'}</code>{' '}
                      donde se insertará el contexto de la historia (globalContext + worldLore + narrativeRules).
                    </p>
                    <RestorablePrompt
                      settingsKey="storyEventGenerationPrompt"
                      value={draft.storyEventGenerationPrompt ?? ''}
                      onChange={(v) => update('storyEventGenerationPrompt', v)}
                      rows={10}
                      mono
                    />
                  </Section>

                  <Section title="Generación de ubicaciones de historia">
                    <p className="text-xs text-text-muted mb-3 leading-relaxed">
                      Prompt usado al generar ubicaciones con IA en el editor de historias (pestaña Ubicaciones).
                      Usa{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'{{NUM_UBICACIONES}}'}</code>{' '}
                      para el número de ubicaciones y{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'{{CONTEXTO_HISTORIA}}'}</code>{' '}
                      donde se insertará el contexto de la historia. El formato de salida esperado es{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'[UBICACION:nombre|descripción|contenido|salidas|atmósfera]'}</code>.
                    </p>
                    <RestorablePrompt
                      settingsKey="storyLocationGenerationPrompt"
                      value={(draft as any).storyLocationGenerationPrompt ?? ''}
                      onChange={(v) => update('storyLocationGenerationPrompt' as any, v)}
                      rows={10}
                      mono
                    />
                  </Section>

                  <Section title="Estilo de narración — prompts de longitud">
                    <p className="text-xs text-text-muted mb-3 leading-relaxed">
                      Cuando un usuario elige "Corto" o "Moderado" en sus Preferencias, se inyecta el prompt correspondiente justo antes de cada turno de generación. Si elige "Normal" no se inyecta nada.
                    </p>
                    <div className="space-y-4">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-medium text-text-secondary">Prompt estilo Moderado</label>
                          <RestoreButton settingsKey="narrationMediumPrompt" onRestore={(v) => update('narrationMediumPrompt', v)} />
                        </div>
                        <textarea
                          value={draft.narrationMediumPrompt ?? ''}
                          onChange={(e) => update('narrationMediumPrompt', e.target.value)}
                          rows={3}
                          className="w-full rounded-lg px-3 py-2 text-xs bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent font-mono resize-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-medium text-text-secondary">Prompt estilo Corto</label>
                          <RestoreButton settingsKey="narrationShortPrompt" onRestore={(v) => update('narrationShortPrompt', v)} />
                        </div>
                        <textarea
                          value={draft.narrationShortPrompt ?? ''}
                          onChange={(e) => update('narrationShortPrompt', e.target.value)}
                          rows={3}
                          className="w-full rounded-lg px-3 py-2 text-xs bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent font-mono resize-none"
                        />
                      </div>
                    </div>
                  </Section>

                  <Section title="Moderación de contenido">
                    <ToggleRow
                      label="Permitir contenido adulto (NSFW)"
                      description="Cuando está desactivado, el sistema detecta y bloquea mensajes con contacto sexual o vocabulario explícito antes de enviarlos al LLM. Si está activado, el LLM principal gestiona el contenido libremente."
                      checked={draft.allowNsfw ?? false}
                      onChange={(v) => update('allowNsfw', v)}
                    />
                    {!(draft.allowNsfw) && (
                      <div className="mt-3 space-y-1">
                        <p className="text-xs text-text-muted">Mensaje de bloqueo mostrado al jugador</p>
                        <div className="space-y-1">
                          <div className="flex justify-end">
                            <RestoreButton settingsKey="nsfwBlockedMessage" onRestore={(v) => update('nsfwBlockedMessage', v)} />
                          </div>
                          <textarea
                            value={draft.nsfwBlockedMessage ?? ''}
                            onChange={(e) => update('nsfwBlockedMessage', e.target.value)}
                            rows={2}
                            className="w-full rounded-lg px-3 py-2 text-xs bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent font-mono resize-none"
                          />
                        </div>
                      </div>
                    )}
                  </Section>

                  {/* ── Estructura visual del prompt ──────────────────────────── */}
                  <Section title="Estructura de la petición al LLM">
                    <p className="text-xs text-text-muted mb-3 leading-relaxed">
                      Orden en que se ensamblan los mensajes enviados al modelo en cada turno de chat.
                      Este es el mismo agrupamiento que verás en los bloques desplegables del "Debug prompt"
                      de cada respuesta.
                    </p>
                    <div className="rounded-lg border border-border bg-surface-2 px-4 py-3 font-mono text-[11px] leading-6 space-y-0.5">
                      <div className="text-text-muted/60 mt-1 mb-0.5">— Mensaje de sistema único (cacheable) —</div>
                      <div>
                        <span className="text-blue-400/80">[SYSTEM]</span>
                        <span className="text-text-secondary ml-2">Prompt de sistema global</span>
                      </div>
                      <div>
                        <span className="text-blue-400/80">[SYSTEM]</span>
                        <span className="text-text-secondary ml-2">Nombre del usuario</span>
                        <span className="text-text-muted/50 ml-1">(si está configurado)</span>
                      </div>
                      <div>
                        <span className="text-blue-400/80">[SYSTEM]</span>
                        <span className="text-text-secondary ml-2">Personaje / Narrador / Game Master</span>
                      </div>
                      <div className="pl-11 text-text-muted">
                        └─ <span className="text-text-muted/70">Aviso de aventura</span>
                        <span className="text-text-muted/40 ml-1">(modo personaje + aventura)</span>
                      </div>
                      <div className="pl-11 text-text-muted">
                        └─ <span className="text-text-muted/70">Otros personajes del grupo</span>
                        <span className="text-text-muted/40 ml-1">(si hay personajes secundarios)</span>
                      </div>
                      <div className="pl-11 text-text-muted">
                        └─ <span className="text-text-muted/70">Formato de respuesta</span>
                        <span className="text-text-muted/40 ml-1">(al final del prompt de personaje)</span>
                      </div>
                      <div>
                        <span className="text-blue-400/80">[SYSTEM]</span>
                        <span className="text-text-secondary ml-2">Lore e historias vinculadas</span>
                        <span className="text-text-muted/50 ml-1">(si las hay)</span>
                      </div>
                      <div>
                        <span className="text-blue-400/80">[SYSTEM]</span>
                        <span className="text-text-secondary ml-2">Memorias activas (bloque básico)</span>
                        <span className="text-text-muted/50 ml-1">(solo si NO hay plantilla de "Memorias inyectadas")</span>
                      </div>
                      <div>
                        <span className="text-amber-400/70">[USER]</span>
                        <span className="text-text-muted mx-1">/</span>
                        <span className="text-green-400/70">[ASSISTANT]</span>
                        <span className="text-text-secondary ml-2">Ejemplos de diálogo</span>
                        <span className="text-text-muted/50 ml-1">(few-shot, si el personaje los tiene)</span>
                      </div>

                      <div className="text-text-muted/40 py-0.5 mt-1">···</div>

                      <div>
                        <span className="text-amber-400/70">[USER]</span>
                        <span className="text-text-muted mx-1">/</span>
                        <span className="text-green-400/70">[ASSISTANT]</span>
                        <span className="text-text-secondary ml-2">Historial de conversación</span>
                      </div>

                      <div className="text-text-muted/40 py-0.5 mt-1">— Bloques de directiva final (ordenados de más estables a más cambiantes, para maximizar la caché) —</div>

                      <div>
                        <span className="text-blue-400/80">[SYSTEM]</span>
                        <span className="text-text-secondary ml-2">Índice de Contexto</span>
                        <span className="text-text-muted/50 ml-1">(ítems relevantes — si está activado)</span>
                      </div>
                      <div>
                        <span className="text-blue-400/80">[SYSTEM]</span>
                        <span className="text-text-secondary ml-2">Trama pendiente</span>
                        <span className="text-text-muted/50 ml-1">(eventos de historia con disparador aún no ocurridos — destinos narrativos; cambia solo cuando un evento ocurre)</span>
                      </div>
                      <div>
                        <span className="text-blue-400/80">[SYSTEM]</span>
                        <span className="text-text-secondary ml-2">Memorias inyectadas</span>
                        <span className="text-text-muted/50 ml-1">(plantilla "Memorias inyectadas" — si hay memorias y está configurada)</span>
                      </div>
                      <div>
                        <span className="text-blue-400/80">[SYSTEM]</span>
                        <span className="text-text-secondary ml-2">Coherencia de escena</span>
                        <span className="text-text-muted/50 ml-1">(siempre — ubicación actual + objetos establecidos, en un solo bloque)</span>
                      </div>
                      <div>
                        <span className="text-blue-400/80">[SYSTEM]</span>
                        <span className="text-text-secondary ml-2">Afinidad / estado emocional</span>
                        <span className="text-text-muted/50 ml-1">(estado actual + reglas de consentimiento — cambia a menudo, por eso va después de la coherencia)</span>
                      </div>
                      <div>
                        <span className="text-blue-400/80">[SYSTEM]</span>
                        <span className="text-text-secondary ml-2">Estilo de narración</span>
                        <span className="text-text-muted/50 ml-1">(si está configurado)</span>
                      </div>
                      <div>
                        <span className="text-blue-400/80">[SYSTEM]</span>
                        <span className="text-text-secondary ml-2">Resumen de sucesos</span>
                        <span className="text-text-muted/50 ml-1">("Historia hasta ahora" — resumen acumulado de TODA la historia, se actualiza cada 6 mensajes; va al final para no romper la caché del resto)</span>
                      </div>
                      <div>
                        <span className="text-amber-400/70">[USER]</span>
                        <span className="text-text-secondary ml-2">Último mensaje del jugador</span>
                        <span className="text-text-muted/50 ml-1">← la generación comienza aquí</span>
                      </div>
                    </div>
                  </Section>
                </>
              )}

              {/* ══ LLM Rápido ═══════════════════════════════════════════════════ */}
              {genTab === 'fast-llm' && (
                <>
                  <p className="text-xs text-text-muted leading-relaxed -mt-2 mb-5 pb-3 border-b border-border/50">
                    Un modelo pequeño que trabaja <strong className="text-text-secondary">en paralelo</strong> al LLM principal.
                    Se ejecuta después de cada respuesta para generar memorias automáticas y actualizar afinidades,
                    sin ocupar espacio en el contexto narrativo. Cuando está activo, el LLM principal ya no necesita
                    emitir etiquetas <code className="bg-surface-3 px-1 rounded text-[10px] text-accent">[AFINIDAD]</code>.
                    <br />
                    <span className="text-text-muted/70 mt-1 inline-block">
                      Recomendado: <strong className="text-text-secondary/70">Qwen2.5 1.5B</strong> · Gemma2 2B · Llama3.2 3B
                    </span>
                  </p>

                  <Section title="LLM Rápido de apoyo">
                    <FastLlmSection
                      providers={providers}
                      enabled={draft.fastLlmEnabled ?? false}
                      providerId={draft.fastLlmProviderId ?? null}
                      modelId={draft.fastLlmModelId ?? null}
                      debugMode={draft.fastLlmDebugMode ?? false}
                      analysisPrompt={draft.fastLlmAnalysisPrompt ?? ''}
                      onEnabledChange={(v) => update('fastLlmEnabled', v)}
                      onProviderChange={(v) => update('fastLlmProviderId', v)}
                      onModelChange={(v) => update('fastLlmModelId', v)}
                      onDebugModeChange={(v) => update('fastLlmDebugMode', v)}
                      onAnalysisPromptChange={(v) => update('fastLlmAnalysisPrompt', v)}
                    />
                  </Section>

                  {/* Affinity prompt — solo visible cuando el LLM Rápido está desactivado */}
                  {!(draft.fastLlmEnabled) && (
                    <Section title="Prompt de Afinidad (LLM Principal)">
                      <p className="text-xs text-text-muted mb-2 leading-relaxed">
                        <span className="text-accent/70 font-mono text-[10px] mr-1">[SYSTEM]</span>
                        Cuando el LLM Rápido está <strong className="text-text-secondary">desactivado</strong>, es el LLM principal quien gestiona la afinidad.
                        Este prompt se inyecta en el system prompt del personaje para guiar su comportamiento según el nivel de afinidad actual.
                        El LLM emite etiquetas{' '}
                        <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">[AFINIDAD:Nombre:±N]</code>{' '}
                        que el servidor recoge para actualizar los valores.
                        <br />
                        <span className="text-text-muted/70 mt-1 inline-block">
                          Activa el LLM Rápido para delegar esto a un modelo dedicado y liberar contexto del LLM principal.
                        </span>
                      </p>
                      <RestorablePrompt
                        settingsKey="affinitySystemPrompt"
                        value={draft.affinitySystemPrompt ?? ''}
                        onChange={(v) => update('affinitySystemPrompt', v)}
                        rows={14}
                        mono
                      />
                    </Section>
                  )}
                </>
              )}

              {/* ══ Embeddings ═══════════════════════════════════════════════════ */}
              {genTab === 'embeddings' && (
                <>
                  <p className="text-xs text-text-muted leading-relaxed -mt-2 mb-5 pb-3 border-b border-border/50">
                    Convierte cada ítem del Índice de Contexto en un <strong className="text-text-secondary">vector semántico</strong>.
                    Permite encontrar ítems relevantes por significado —"el gran enemigo" localiza "Skareth el dragón"—
                    en lugar de coincidencia exacta de palabras. Aquí también se configura el LLM
                    encargado de la <strong className="text-text-secondary">extracción del índice</strong>.
                  </p>

                  <Section title="Modelo de embeddings">
                    <p className="text-xs text-text-muted mb-2 leading-relaxed">
                      Usa un modelo especializado en representaciones vectoriales (distinto al modelo de chat).
                      En Ollama: <code className="font-mono text-accent/80 text-[11px]">ollama pull nomic-embed-text</code>.
                      También compatible con cualquier proveedor OpenAI-compatible.
                    </p>
                    <ToggleRow
                      label="Activar embeddings semánticos"
                      description="Cada extracción guardará un vector por ítem. La inyección usará cosine similarity para seleccionar los más relevantes al mensaje actual."
                      checked={draft.embeddingEnabled ?? false}
                      onChange={(v) => update('embeddingEnabled', v)}
                    />
                    {(draft.embeddingEnabled) && (
                      <div className="mt-3">
                        <DefaultModelSection
                          providers={providers}
                          defaultProviderId={draft.embeddingProviderId ?? null}
                          defaultModelId={draft.embeddingModel ?? null}
                          onProviderChange={(v) => update('embeddingProviderId', v)}
                          onModelChange={(v) => update('embeddingModel', v)}
                          hideDescription
                        />
                      </div>
                    )}
                  </Section>

                  <Section title="Extracción del Índice de Contexto">
                    <p className="text-xs text-text-muted mb-2 leading-relaxed">
                      Instrucciones que el LLM recibe al analizar fragmentos de conversación para extraer
                      eventos, personajes, lugares y conquistas.{' '}
                      Variables:{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'{{fragmento}}'}</code>{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'{{desde}}'}</code>{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'{{hasta}}'}</code>{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'{{total}}'}</code>{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'{{personajes_conocidos}}'}</code>{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">{'{{historias_conocidas}}'}</code>.
                      {' '}Etiquetas de salida:{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">[EVENTO:...|...|N]</code>{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">[PERSONAJE:...|...|N]</code>{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">[LUGAR:...|...|N]</code>{' '}
                      <code className="bg-white/8 px-1 rounded text-accent/80 font-mono text-[10px]">[CONQUISTA:...|...|N]</code>.
                    </p>
                    <Input
                      label="Ventana de contexto del LLM (tokens)"
                      type="number"
                      value={draft.contextIndexContextSize ?? 8192}
                      onChange={(e) => update('contextIndexContextSize', parseInt(e.target.value) || 8192)}
                      min={2048}
                      max={131072}
                      hint="Ventana usada al extraer. Auméntala si el modelo admite contexto largo y procesas lotes grandes."
                    />
                    <div className="mt-3">
                      <RestorablePrompt
                        settingsKey="contextIndexPrompt"
                        value={draft.contextIndexPrompt ?? ''}
                        onChange={(v) => update('contextIndexPrompt', v)}
                        rows={14}
                        mono
                      />
                    </div>
                  </Section>

                  {/* ── Auto-extracción ─────────────────────────────────────── */}
                  <Section title="Auto-extracción del Índice de Contexto">
                    <p className="text-xs text-text-muted mb-3 leading-relaxed">
                      Analiza automáticamente la conversación en background cada N mensajes nuevos y extrae eventos, lugares y personajes al índice. No bloquea la respuesta del LLM.
                    </p>
                    <ToggleRow
                      label="Activar auto-extracción"
                      description="Analiza la conversación en background tras cada respuesta cuando se acumulan suficientes mensajes."
                      checked={draft.contextAutoExtractEnabled ?? false}
                      onChange={(v) => update('contextAutoExtractEnabled', v)}
                    />
                    {draft.contextAutoExtractEnabled && (
                      <div className="mt-3 space-y-3">
                        <Input
                          label="Intervalo (mensajes nuevos)"
                          type="number"
                          value={draft.contextAutoExtractInterval ?? 8}
                          onChange={(e) => update('contextAutoExtractInterval', parseInt(e.target.value) || 8)}
                          min={4}
                          max={50}
                          hint="Cada cuántos mensajes nuevos se lanza una extracción. 8 es un buen equilibrio entre frecuencia y coste."
                        />
                        <p className="text-[11px] text-text-muted leading-relaxed">
                          <strong>Provider:</strong> Si no se configura uno específico, usa el LLM Rápido (si está activo) o el provider por defecto. Para mantener el coste bajo, usa un modelo rápido y barato.
                        </p>
                        <DefaultModelSection
                          providers={providers}
                          defaultProviderId={draft.contextAutoExtractProviderId ?? null}
                          defaultModelId={draft.contextAutoExtractModelId ?? null}
                          onProviderChange={(v) => { update('contextAutoExtractProviderId', v); update('contextAutoExtractModelId', null); }}
                          onModelChange={(v) => update('contextAutoExtractModelId', v)}
                          hideDescription
                        />
                      </div>
                    )}
                  </Section>
                </>
              )}

              {/* ══ Generación de imágenes ══════════════════════════════════════ */}
              {genTab === 'images' && draft && (
                <ImageGenTab
                  draft={draft}
                  update={update}
                  providers={providers}
                />
              )}

              {/* ── Common save bar ───────────────────────────────────────────── */}
              <SaveBar onSave={() => save(GENERATION_KEYS)} isPending={updateSettings.isPending} isSuccess={updateSettings.isSuccess} />
            </>
          )}

          {tab === 'context' && isAdmin && (
            <>
              <Section title="Estrategia de contexto">
                <div className="flex gap-2">
                  {(['rolling', 'summary', 'hybrid'] as const).map((s) => (
                    <button key={s} onClick={() => update('contextStrategy', s)}
                      className={`flex-1 py-2 rounded-lg text-sm capitalize border transition-colors ${
                        draft.contextStrategy === s ? 'border-accent bg-accent-muted text-accent' : 'border-border text-text-secondary hover:border-accent/40'
                      }`}>
                      {s}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-text-muted">
                  Rolling: últimos N mensajes. Summary: resume contexto antiguo. Hybrid: ambos.
                </p>
              </Section>
              <Section title="Tokens de respuesta">
                <Input
                  label="Máximo tokens por respuesta"
                  type="number"
                  value={draft.maxResponseTokens ?? ''}
                  onChange={(e) => update('maxResponseTokens', e.target.value ? parseInt(e.target.value) : null)}
                  min={64}
                  placeholder="Sin límite (recomendado)"
                  hint="Deja vacío para que el modelo genere respuestas completas sin cortar."
                />
              </Section>
              <Section title="Ventana de contexto">
                <Input
                  label="Tokens de contexto de entrada"
                  type="number"
                  value={draft.defaultContextLength ?? 32768}
                  onChange={(e) => update('defaultContextLength', parseInt(e.target.value) || 32768)}
                  min={1024}
                  max={131072}
                  hint="Tamaño MÍNIMO (en tokens) de la ventana de contexto para TODOS los personajes. Si un personaje tiene un 'Context Length' propio menor que este valor, se ignora y se usa este valor global; si lo tiene mayor, se respeta el del personaje. Es decir, este valor es el suelo: el contexto efectivo nunca será menor que esto."
                />
                <Input label="Máx. mensajes en contexto" type="number" value={draft.maxContextMessages}
                  onChange={(e) => update('maxContextMessages', parseInt(e.target.value))} min={5} max={200}
                  hint="Número máximo de mensajes del historial considerados antes de aplicar el recorte por tokens. El recorte final también respeta siempre los últimos mensajes reales más los bloques de directivas (afinidad, ubicación, objetos, memorias, etc.)." />
                <Input label="Umbral de auto-resumen" type="number" value={draft.autoSummarizeThreshold}
                  onChange={(e) => update('autoSummarizeThreshold', parseInt(e.target.value))} min={5} max={200}
                  hint="Resumir contexto cuando el número de mensajes supera este valor." />
              </Section>
              <SaveBar onSave={() => save(CONTEXT_KEYS)} isPending={updateSettings.isPending} isSuccess={updateSettings.isSuccess} />
            </>
          )}

          {tab === 'providers' && isAdmin && (
            <>
              <ProvidersSection providers={providers} />

              <div className="border-t border-border pt-5 space-y-4">
                <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                  Generación de imagen
                </h3>
                <ImageProviderSection draft={draft} update={update} />
                <SaveBar
                  onSave={() => save(INTEGRATIONS_KEYS)}
                  isPending={updateSettings.isPending}
                  isSuccess={updateSettings.isSuccess}
                />
              </div>
            </>
          )}

          {tab === 'voice' && isAdmin && (
            <VoiceSection settings={settings} onUpdate={(patch) => updateSettings.mutate({ ttsSettings: patch })} />
          )}

          {tab === 'stats' && isAdmin && <StatsSection />}

          {tab === 'users' && isAdmin && <UsersSection />}

          {tab === 'backup' && isAdmin && <BackupSection />}
        </div>
      </div>
    </div>
  );
}

// ─── Voice / TTS section ─────────────────────────────────────────────────────

// Static catalog — Edge TTS fallback when API is unavailable
const STATIC_CATALOG: Omit<TtsVoice, 'available'>[] = [
  { id: 'edge_elvira',   name: 'Elvira',   gender: 'female', type: 'cloud', description: 'Voz neural femenina, acento español (Microsoft)' },
  { id: 'edge_irene',    name: 'Irene',    gender: 'female', type: 'cloud', description: 'Voz neural femenina cálida, acento español (Microsoft)' },
  { id: 'edge_triana',   name: 'Triana',   gender: 'female', type: 'cloud', description: 'Voz neural femenina expresiva, acento español (Microsoft)' },
  { id: 'edge_abril',    name: 'Abril',    gender: 'female', type: 'cloud', description: 'Voz neural femenina amigable, acento español (Microsoft)' },
  { id: 'edge_estrella', name: 'Estrella', gender: 'female', type: 'cloud', description: 'Voz neural femenina positiva, acento español (Microsoft)' },
  { id: 'edge_laia',     name: 'Laia',     gender: 'female', type: 'cloud', description: 'Voz neural femenina cálida, acento español (Microsoft)' },
  { id: 'edge_vera',     name: 'Vera',     gender: 'female', type: 'cloud', description: 'Voz neural femenina clara, acento español (Microsoft)' },
  { id: 'edge_ximena',   name: 'Ximena',   gender: 'female', type: 'cloud', description: 'Voz neural femenina multilingüe, acento español (Microsoft)' },
  { id: 'edge_arabella', name: 'Arabella', gender: 'female', type: 'cloud', description: 'Voz neural femenina multilingüe expresiva, acento español (Microsoft)' },
  { id: 'edge_isidora',  name: 'Isidora',  gender: 'female', type: 'cloud', description: 'Voz neural femenina multilingüe serena, acento español (Microsoft)' },
  { id: 'edge_dalia',    name: 'Dalia',    gender: 'female', type: 'cloud', description: 'Voz neural femenina, acento mexicano (Microsoft)' },
  { id: 'edge_candela',  name: 'Candela',  gender: 'female', type: 'cloud', description: 'Voz neural femenina expresiva, acento mexicano (Microsoft)' },
  { id: 'edge_elena_ar', name: 'Elena AR', gender: 'female', type: 'cloud', description: 'Voz neural femenina, acento argentino (Microsoft)' },
  { id: 'edge_salome',   name: 'Salomé',   gender: 'female', type: 'cloud', description: 'Voz neural femenina, acento colombiano (Microsoft)' },
  { id: 'edge_paloma',   name: 'Paloma',   gender: 'female', type: 'cloud', description: 'Voz neural femenina neutra, español americano (Microsoft)' },
  { id: 'edge_alvaro',   name: 'Álvaro',   gender: 'male',   type: 'cloud', description: 'Voz neural masculina, acento español (Microsoft)' },
  { id: 'edge_saul',     name: 'Saúl',     gender: 'male',   type: 'cloud', description: 'Voz neural masculina natural, acento español (Microsoft)' },
  { id: 'edge_jorge_mx', name: 'Jorge',    gender: 'male',   type: 'cloud', description: 'Voz neural masculina, acento mexicano (Microsoft)' },
  { id: 'edge_tomas_ar', name: 'Tomás AR', gender: 'male',   type: 'cloud', description: 'Voz neural masculina, acento argentino (Microsoft)' },
  { id: 'edge_gonzalo',  name: 'Gonzalo',  gender: 'male',   type: 'cloud', description: 'Voz neural masculina, acento colombiano (Microsoft)' },
];

const PREVIEW_TEXT = 'El viento susurraba entre las ruinas del castillo mientras la aventura comenzaba a desplegarse ante ti.';

// Module-level preview audio (single instance)
let _previewAudio: HTMLAudioElement | null = null;
let _previewUrl:   string | null = null;

function stopPreview() {
  if (_previewAudio) { _previewAudio.pause(); _previewAudio.src = ''; _previewAudio = null; }
  if (_previewUrl)   { URL.revokeObjectURL(_previewUrl); _previewUrl = null; }
}

function VoiceSection({
  settings,
  onUpdate,
}: {
  settings: AppSettings;
  onUpdate: (patch: TtsSettings) => void;
}) {
  const tts = settings.ttsSettings;
  function setTts(partial: Partial<TtsSettings>) { onUpdate({ ...tts, ...partial }); }


  // Voices
  const qc = useQueryClient();
  const { data: liveVoices, refetch: refetchVoices } = useQuery({
    queryKey: ['tts-voices'],
    queryFn: ttsApi.voices,
    retry: false,
    staleTime: 30_000,
  });
  const voices: TtsVoice[] = (liveVoices && liveVoices.length > 0)
    ? liveVoices
    : STATIC_CATALOG.map((v) => ({ ...v, available: true }));
  const females = voices.filter((v) => v.gender === 'female');
  const males   = voices.filter((v) => v.gender === 'male');

  // Download
  const [downloading, setDownloading] = React.useState<string | null>(null);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);

  async function download(voiceId: string) {
    setDownloading(voiceId);
    setDownloadError(null);
    try {
      await ttsApi.downloadVoice(voiceId);
      await refetchVoices();
      qc.invalidateQueries({ queryKey: ['tts-voices'] });
    } catch (e) {
      setDownloadError(voiceId);
    } finally {
      setDownloading(null);
    }
  }

  // Preview
  const [previewing, setPreviewing] = React.useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState<string | null>(null);

  async function togglePreview(voiceId: string, speed: number, temperature: number) {
    if (previewing === voiceId || previewLoading === voiceId) {
      stopPreview();
      setPreviewing(null);
      setPreviewLoading(null);
      return;
    }
    stopPreview();
    setPreviewing(null);
    setPreviewLoading(voiceId);

    // iOS fix: desbloquear AudioContext dentro del handler del gesto (antes del fetch)
    const AudioCtxClass = window.AudioContext ?? (window as Record<string,unknown>).webkitAudioContext as typeof AudioContext | undefined;
    let audioCtx: AudioContext | null = null;
    if (AudioCtxClass) {
      try { audioCtx = new AudioCtxClass(); await audioCtx.resume(); } catch { audioCtx = null; }
    }

    try {
      const resp = await fetch('/api/tts/synthesize', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body:    JSON.stringify({ text: PREVIEW_TEXT, voiceId, speed, temperature }),
      });
      if (!resp.ok) throw new Error('Error de síntesis');

      if (audioCtx) {
        // Ruta AudioContext — compatible con iOS y voces cloud (MP3 o WAV)
        const arrayBuffer = await resp.arrayBuffer();
        const decoded     = await audioCtx.decodeAudioData(arrayBuffer);
        const source      = audioCtx.createBufferSource();
        source.buffer     = decoded;
        source.connect(audioCtx.destination);
        source.onended    = () => { try { audioCtx?.close(); } catch {} setPreviewing(null); };
        setPreviewing(voiceId);
        setPreviewLoading(null);
        source.start(0);
      } else {
        // Fallback: HTMLAudioElement
        const contentType = resp.headers.get('content-type') ?? 'audio/wav';
        const blob = new Blob([await resp.arrayBuffer()], { type: contentType });
        _previewUrl   = URL.createObjectURL(blob);
        _previewAudio = new Audio(_previewUrl);
        _previewAudio.onended = () => { stopPreview(); setPreviewing(null); };
        _previewAudio.onerror = () => { stopPreview(); setPreviewing(null); };
        setPreviewing(voiceId);
        setPreviewLoading(null);
        await _previewAudio.play();
      }
    } catch (e) {
      console.error('[TTS preview]', e);
      if (audioCtx) try { audioCtx.close(); } catch {}
      stopPreview();
      setPreviewLoading(null);
    }
  }

  // Stop preview when unmounting
  useEffect(() => () => stopPreview(), []);

  return (
    <>
      {/* ── Service ──────────────────────────────────────────────────────────── */}
      <Section title="Servicio TTS">
        <div className="space-y-3">
          <ToggleRow
            label="Activar síntesis de voz"
            description="Muestra el botón de altavoz en los mensajes de la IA"
            checked={tts.enabled}
            onChange={(v) => setTts({ enabled: v })}
          />
          <div className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-lg border border-green-500/30 bg-green-500/8 text-green-400">
            <Wifi size={11} />
            Microsoft Edge TTS — voces neurales en la nube, sin configuración adicional
          </div>
        </div>
      </Section>

      {/* ── Playback parameters ──────────────────────────────────────────────── */}
      <Section title="Parámetros de reproducción">
        <ToggleRow
          label="Reproducir automáticamente"
          description="Reproduce cada respuesta de la IA sin pulsar el botón"
          checked={tts.autoPlay}
          onChange={(v) => setTts({ autoPlay: v })}
        />
        <SliderRow label="Velocidad" value={tts.speed} min={0.5} max={2.0} step={0.1}
          format={(v) => `${v.toFixed(1)}×`} onChange={(v) => setTts({ speed: v })} />
        <SliderRow label="Expresividad" value={tts.temperature} min={0.1} max={1.0} step={0.05}
          format={(v) => v.toFixed(2)} onChange={(v) => setTts({ temperature: v })}
          hint="Baja = voz estable. Alta = más dinámica pero menos precisa." />
      </Section>

      {/* ── Reemplazos de texto ──────────────────────────────────────────────── */}
      <ReplacementsSection replacements={tts.replacements ?? []}
        onChange={(r) => setTts({ replacements: r })} />

      {/* ── Voice selection ──────────────────────────────────────────────────── */}
      <Section title="Voces femeninas">
        <VoiceGrid voices={females} selectedId={tts.defaultVoiceId}
          onSelect={(id) => setTts({ defaultVoiceId: id })}
          downloading={downloading} downloadError={downloadError} onDownload={download}
          previewing={previewing} previewLoading={previewLoading}
          onPreview={(id) => togglePreview(id, tts.speed, tts.temperature)} />
      </Section>
      <Section title="Voces masculinas">
        <VoiceGrid voices={males} selectedId={tts.defaultVoiceId}
          onSelect={(id) => setTts({ defaultVoiceId: id })}
          downloading={downloading} downloadError={downloadError} onDownload={download}
          previewing={previewing} previewLoading={previewLoading}
          onPreview={(id) => togglePreview(id, tts.speed, tts.temperature)} />
      </Section>

      {/* ── Banco de pruebas ─────────────────────────────────────────────────── */}
      <VoiceTestBench voices={voices} speed={tts.speed} temperature={tts.temperature} />
    </>
  );
}

// ─── Voice Test Bench ─────────────────────────────────────────────────────────

const TEST_SENTENCES = [
  {
    label: 'Narración de escena',
    text: 'El viento susurraba entre los árboles mientras la niebla se alzaba sobre el valle, ocultando secretos que nadie se atrevía a pronunciar en voz alta.',
  },
  {
    label: 'Diálogo íntimo',
    text: '¿De verdad crees que no lo sé? He estado esperando este momento durante años. Y ahora que estás aquí... no sé si reír o llorar.',
  },
  {
    label: 'Tensión y acción',
    text: 'No te muevas. Ni un solo paso más, o juro que no respondo de lo que pueda pasar. Tenemos muy poco tiempo y necesito que me escuches.',
  },
  {
    label: 'Tono suave y cercano',
    text: 'Oye, tranquila. Sé que todo parece imposible ahora mismo, pero estoy aquí. No te voy a dejar sola. ¿Me oyes? Juntos lo vamos a resolver.',
  },
  {
    label: 'Reflexión y emoción',
    text: 'A veces pienso que el destino nos pone donde tiene que ponernos, aunque en el momento no lo entendamos. Quizás todo esto tiene un sentido que todavía no somos capaces de ver.',
  },
];

function VoiceTestBench({
  voices, speed, temperature,
}: {
  voices: TtsVoice[];
  speed: number;
  temperature: number;
}) {
  const [selectedSentenceIdx, setSelectedSentenceIdx] = React.useState(0);
  const [customText, setCustomText] = React.useState('');
  const [playingId, setPlayingId] = React.useState<string | null>(null);
  const [loadingId, setLoadingId] = React.useState<string | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  const activeText = customText.trim() || TEST_SENTENCES[selectedSentenceIdx].text;

  // Only show available voices (cloud always available, local only if downloaded)
  const availableVoices = voices.filter((v) => v.type === 'cloud' || v.available);
  const femaleVoices = availableVoices.filter((v) => v.gender === 'female');

  function stopCurrent() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    setPlayingId(null);
    setLoadingId(null);
  }

  async function playVoice(voiceId: string) {
    if (playingId === voiceId || loadingId === voiceId) { stopCurrent(); return; }
    stopCurrent();
    setLoadingId(voiceId);
    try {
      const token = localStorage.getItem('rpgspeak_token');
      const resp = await fetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text: activeText, voiceId, speed, temperature }),
      });
      if (!resp.ok) throw new Error('Error de síntesis');
      const contentType = resp.headers.get('content-type') ?? 'audio/wav';
      const blob = new Blob([await resp.arrayBuffer()], { type: contentType });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); setPlayingId(null); };
      audio.onerror = () => { URL.revokeObjectURL(url); setPlayingId(null); };
      setPlayingId(voiceId);
      setLoadingId(null);
      await audio.play();
    } catch {
      setLoadingId(null);
    }
  }

  return (
    <Section title="🎧 Banco de pruebas de voces">
      <p className="text-xs text-text-muted mb-3 leading-relaxed">
        Prueba cualquier voz con las frases de ejemplo o escribe tu propio texto. Solo se muestran las voces disponibles (cloud siempre, locales si están descargadas).
      </p>

      {/* Sentence picker */}
      <div className="space-y-2 mb-3">
        <p className="text-[11px] font-medium text-text-secondary">Frase de ejemplo:</p>
        <div className="flex flex-wrap gap-1.5">
          {TEST_SENTENCES.map((s, i) => (
            <button
              key={i}
              onClick={() => { setSelectedSentenceIdx(i); setCustomText(''); }}
              className={`text-[10px] px-2.5 py-1 rounded-full border transition-colors ${
                i === selectedSentenceIdx && !customText
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-border text-text-muted hover:border-accent/40 hover:text-text-primary'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-text-muted italic px-1 leading-relaxed">
          "{TEST_SENTENCES[selectedSentenceIdx].text.slice(0, 90)}…"
        </p>
      </div>

      {/* Custom text */}
      <div className="mb-4">
        <textarea
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          placeholder="O escribe tu propio texto para probar…"
          rows={2}
          className="w-full text-xs bg-transparent border border-border rounded-lg px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-none"
        />
      </div>

      {/* Female voices */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold text-text-secondary flex items-center gap-1.5">
          <span className="text-pink-400">♀</span> Voces femeninas disponibles
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
          {femaleVoices.map((v) => {
            const isPlaying = playingId === v.id;
            const isLoading = loadingId === v.id;
            return (
              <button
                key={v.id}
                onClick={() => playVoice(v.id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-left transition-all ${
                  isPlaying
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-border text-text-secondary hover:border-accent/40 hover:bg-white/3'
                }`}
              >
                <span className="flex-shrink-0">
                  {isLoading
                    ? <Loader size={11} className="animate-spin text-accent" />
                    : isPlaying
                    ? <Square size={11} className="text-accent fill-current" />
                    : <Play size={11} />}
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-medium truncate">{v.name}</p>
                  <p className="text-[9px] text-text-muted truncate">
                    {v.type === 'cloud' ? '☁ Edge' : '⬢ local'} · {v.description?.split(',')[0]}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
        {femaleVoices.length === 0 && (
          <p className="text-xs text-text-muted italic">No hay voces femeninas disponibles. Descarga alguna voz local o verifica la conexión para las voces cloud.</p>
        )}
      </div>
    </Section>
  );
}

// ─── TTS Replacements Section ────────────────────────────────────────────────

function ReplacementsSection({
  replacements,
  onChange,
}: {
  replacements: import('@rpgspeak/shared').TtsTextReplacement[];
  onChange: (r: import('@rpgspeak/shared').TtsTextReplacement[]) => void;
}) {
  const [search,  setSearch]  = React.useState('');
  const [replace, setReplace] = React.useState('');
  const [error,   setError]   = React.useState('');

  function add() {
    const s = search.trim();
    const r = replace.trim();
    if (!s) { setError('El texto a buscar no puede estar vacío.'); return; }
    if (replacements.some((x) => x.search.toLowerCase() === s.toLowerCase())) {
      setError('Ya existe un reemplazo para ese texto.'); return;
    }
    onChange([...replacements, { search: s, replace: r }]);
    setSearch('');
    setReplace('');
    setError('');
  }

  function remove(idx: number) {
    onChange(replacements.filter((_, i) => i !== idx));
  }

  return (
    <Section title="Reemplazos de pronunciación">
      <p className="text-xs text-text-muted mb-3 leading-relaxed">
        Corrige pronunciaciones incorrectas. El texto se busca sin distinguir mayúsculas.
        Ej: «Natasha» → «Natacha», «NPC» → «ene pe ce».
      </p>

      {/* Lista de reemplazos existentes */}
      {replacements.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {replacements.map((rep, idx) => (
            <div key={idx}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-xs"
              style={{ background: 'var(--surface-2)' }}
            >
              <span className="font-mono text-text-primary flex-shrink-0">{rep.search}</span>
              <span className="text-text-muted flex-shrink-0">→</span>
              <span className="font-mono text-accent flex-1 min-w-0 truncate">
                {rep.replace || <em className="text-text-muted not-italic">(eliminar)</em>}
              </span>
              <button
                onClick={() => remove(idx)}
                className="flex-shrink-0 p-0.5 rounded hover:bg-red-500/15 text-text-muted hover:text-red-400 transition-colors"
                title="Eliminar"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Formulario de nuevo reemplazo */}
      <div className="flex gap-2 items-start">
        <div className="flex-1 space-y-1.5">
          <input
            type="text"
            placeholder="Buscar…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setError(''); }}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            className="w-full rounded-lg px-3 py-1.5 text-xs border border-border bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent font-mono"
          />
          <input
            type="text"
            placeholder="Reemplazar con…"
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            className="w-full rounded-lg px-3 py-1.5 text-xs border border-border bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent font-mono"
          />
        </div>
        <button
          onClick={add}
          disabled={!search.trim()}
          className="mt-0.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-accent/60 text-accent hover:bg-accent/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
        >
          Añadir
        </button>
      </div>

      {error && <p className="text-[11px] text-red-400 mt-1.5">{error}</p>}

      {replacements.length === 0 && (
        <p className="text-[11px] text-text-muted mt-2 italic">Sin reemplazos configurados.</p>
      )}
    </Section>
  );
}

function SliderRow({
  label, value, min, max, step, format, hint, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  format: (v: number) => string; hint?: string; onChange: (v: number) => void;
}) {
  return (
    <div className="py-2 border-b border-border last:border-0 space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{label}</p>
        <span className="text-xs font-mono text-accent">{format(value)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-accent"
      />
      {hint && <p className="text-[10px] text-text-muted">{hint}</p>}
    </div>
  );
}

function VoiceGrid({
  voices, selectedId, onSelect,
  downloading, downloadError, onDownload,
  previewing, previewLoading, onPreview,
}: {
  voices: TtsVoice[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  downloading: string | null;
  downloadError: string | null;
  onDownload: (id: string) => void;
  previewing: string | null;
  previewLoading: string | null;
  onPreview: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {voices.map((voice) => {
        const isSelected    = selectedId === voice.id;
        const isDownloading = downloading === voice.id;
        const hasError      = downloadError === voice.id;
        const isCloud       = voice.type === 'cloud';
        const needsDownload = !isCloud && !voice.available;
        const isPreviewing  = previewing === voice.id;
        const isLoadingPrev = previewLoading === voice.id;

        return (
          <div
            key={voice.id}
            className={`relative flex flex-col p-3 rounded-xl border transition-all ${
              isSelected
                ? 'border-accent'
                : needsDownload
                ? 'border-border opacity-70'
                : 'border-border hover:border-accent/40'
            }`}
            style={{ background: isSelected ? 'rgba(var(--accent-rgb,99,102,241),0.08)' : 'var(--surface-2)' }}
          >
            {/* Header row: icon + name + badge + selected check */}
            <div className="flex items-start gap-2">
              <div className={`mt-0.5 p-1 rounded-md flex-shrink-0 ${isSelected ? 'bg-accent/20' : 'bg-white/8'}`}>
                <Volume2 size={11} className={isSelected ? 'text-accent' : 'text-text-muted'} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={`text-xs font-semibold ${isSelected ? 'text-accent' : 'text-text-primary'}`}>
                    {voice.name}
                  </span>
                  {isCloud ? (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-blue-500/15 text-blue-400 leading-none flex-shrink-0">
                      ☁ cloud
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500/15 text-emerald-400 leading-none flex-shrink-0">
                      ⬢ local
                    </span>
                  )}
                  {isSelected && <CheckCircle2 size={10} className="text-accent flex-shrink-0" />}
                </div>
                <p className="text-[10px] text-text-muted leading-tight mt-0.5 line-clamp-2">
                  {voice.description}
                </p>
              </div>
            </div>

            {/* Action row */}
            <div className="flex gap-1.5 mt-2.5">
              {needsDownload ? (
                /* ── Download button ── */
                <button
                  onClick={() => onDownload(voice.id)}
                  disabled={isDownloading}
                  className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg border text-[10px] font-medium transition-colors disabled:opacity-50 ${
                    hasError
                      ? 'border-red-500/40 text-red-400 hover:bg-red-500/10'
                      : 'border-accent/50 text-accent hover:bg-accent/10'
                  }`}
                >
                  <Download size={9} className={isDownloading ? 'animate-bounce' : ''} />
                  {isDownloading ? 'Descargando…' : hasError ? 'Reintentar' : 'Descargar voz'}
                </button>
              ) : (
                <>
                  {/* ── Select button ── */}
                  <button
                    onClick={() => onSelect(voice.id)}
                    className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg border text-[10px] font-medium transition-colors ${
                      isSelected
                        ? 'border-accent/60 bg-accent/15 text-accent cursor-default'
                        : 'border-border text-text-muted hover:border-accent/50 hover:text-text-primary hover:bg-white/5'
                    }`}
                  >
                    {isSelected ? <><CheckCircle2 size={9} /> Seleccionada</> : 'Seleccionar'}
                  </button>

                  {/* ── Preview button ── */}
                  <button
                    onClick={() => onPreview(voice.id)}
                    disabled={isLoadingPrev}
                    title={isPreviewing ? 'Detener preview' : 'Escuchar ejemplo'}
                    className={`flex items-center justify-center w-7 rounded-lg border text-[10px] transition-colors disabled:opacity-50 ${
                      isPreviewing
                        ? 'border-accent/60 bg-accent/15 text-accent'
                        : 'border-border text-text-muted hover:border-accent/50 hover:text-accent hover:bg-accent/8'
                    }`}
                  >
                    {isLoadingPrev
                      ? <Loader size={9} className="animate-spin" />
                      : isPreviewing
                      ? <Square size={9} />
                      : <Play size={9} />
                    }
                  </button>
                </>
              )}
            </div>

            {/* Download progress hint */}
            {isDownloading && (
              <p className="mt-1.5 text-[9px] text-text-muted text-center">
                Descargando modelo (~60 MB)…
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Section ─────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function ToggleRow({ label, description, checked, onChange }: {
  label: string; description: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-text-muted">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-surface-3'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}

// ─── Shared restore helpers ───────────────────────────────────────────────────

/** Inline "Restaurar" button — use inside custom layouts (e.g. FastLlmSection). */
function RestoreButton({ settingsKey, onRestore }: { settingsKey: keyof AppSettings; onRestore: (v: string) => void }) {
  const [restoring, setRestoring] = useState(false);
  async function handleRestore() {
    setRestoring(true);
    try { onRestore((await settingsApi.getDefault(settingsKey)).value as string); }
    catch { /* silently ignore */ }
    finally { setRestoring(false); }
  }
  return (
    <button
      onClick={handleRestore}
      disabled={restoring}
      title="Restaurar valor por defecto"
      className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-text-muted hover:text-text-primary hover:bg-white/8 border border-border transition-colors"
    >
      {restoring ? <Loader size={11} className="animate-spin" /> : <RotateCcw size={11} />}
      Restaurar
    </button>
  );
}

// ─── Reusable restorable prompt textarea ─────────────────────────────────────

function RestorablePrompt({
  settingsKey,
  value,
  onChange,
  rows = 10,
  mono = false,
  hint,
}: {
  settingsKey: keyof AppSettings;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <RestoreButton settingsKey={settingsKey} onRestore={onChange} />
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className={mono ? 'font-mono text-xs' : undefined}
        hint={hint}
      />
    </div>
  );
}

// ─── Image generation tab ────────────────────────────────────────────────────

function ImageGenTab({
  draft,
  update,
  providers,
}: {
  draft: Partial<AppSettings>;
  update: (k: keyof AppSettings, v: unknown) => void;
  providers: Provider[];
}) {
  const [testCharId,   setTestCharId]   = React.useState('');
  const [testResult,   setTestResult]   = React.useState('');
  const [testLoading,  setTestLoading]  = React.useState(false);
  const [testError,    setTestError]    = React.useState<string | null>(null);
  const [testProvider, setTestProvider] = React.useState('');
  const [testModel,    setTestModel]    = React.useState('');
  const qc = useQueryClient();

  const allChars: { id: string; name: string }[] = qc.getQueryData(['characters']) ?? [];

  async function runCharTest() {
    if (!testCharId) return;
    setTestLoading(true);
    setTestResult('');
    setTestError(null);
    try {
      const res = await charactersApi.generateImageDescription(
        testCharId,
        testProvider ? { providerId: testProvider, modelId: testModel || undefined } : undefined,
      );
      setTestResult(res.description);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Error al generar');
    } finally {
      setTestLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-text-muted leading-relaxed -mt-2 mb-5 pb-3 border-b border-border/50">
        Prompts que el LLM usa para <strong className="text-text-secondary">convertir datos en prompts de imagen</strong>.
        Los cambios aquí afectan a la generación de escenas del chat y a las descripciones visuales de personajes.
      </p>

      {/* ── Scene image prompt ───────────────────────────────────────────── */}
      <ScenePromptSection
        value={draft.sceneImagePrompt ?? ''}
        onChange={(v) => update('sceneImagePrompt', v)}
      />

      {/* ── Background image prompt ─────────────────────────────────────── */}
      <BackgroundPromptSection
        value={draft.backgroundImagePrompt ?? ''}
        onChange={(v) => update('backgroundImagePrompt', v)}
      />

      {/* ── Character image prompt ──────────────────────────────────────── */}
      <Section title="Prompt de descripción visual de personaje">
        <p className="text-xs text-text-muted mb-1 leading-relaxed">
          Plantilla que convierte los datos del personaje en un prompt de imagen.
          Usa{' '}
          {(['{{nombre}}', '{{descripcion}}', '{{personalidad}}', '{{lore}}'] as const).map((v, i, arr) => (
            <React.Fragment key={v}>
              <code className="bg-surface-3 px-1 rounded text-accent font-mono text-[10px]">{v}</code>
              {i < arr.length - 1 ? ', ' : ''}
            </React.Fragment>
          ))}
          {' '}como variables.
        </p>
        <RestorablePrompt
          settingsKey="charImagePrompt"
          value={draft.charImagePrompt ?? ''}
          onChange={(v) => update('charImagePrompt', v)}
          rows={14}
          mono
        />

        {/* ── Test widget ─────────────────────────────────────────────── */}
        <div className="mt-4 rounded-xl border border-border/60 bg-surface-1/40 p-4 space-y-3">
          <p className="text-[11px] font-semibold text-text-secondary">Probar prompt con un personaje</p>
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex-1 min-w-[140px] space-y-1">
              <label className="text-xs text-text-muted">Personaje</label>
              <select
                value={testCharId}
                onChange={(e) => setTestCharId(e.target.value)}
                className="w-full bg-surface-2 border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">— Selecciona —</option>
                {allChars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[140px] space-y-1">
              <label className="text-xs text-text-muted">Provider (opcional)</label>
              <select
                value={testProvider}
                onChange={(e) => { setTestProvider(e.target.value); setTestModel(''); }}
                className="w-full bg-surface-2 border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">— Por defecto —</option>
                {providers.filter((p) => p.isEnabled).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <button
              onClick={runCharTest}
              disabled={!testCharId || testLoading}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
            >
              {testLoading ? <><Loader size={11} className="animate-spin" /> Generando…</> : <><Wand2 size={11} /> Probar</>}
            </button>
          </div>
          {testError && <p className="text-xs text-red-400">{testError}</p>}
          {testResult && (
            <div className="mt-2">
              <p className="text-[10px] font-semibold text-text-secondary mb-1">Resultado:</p>
              <div className="bg-surface-2 rounded-lg p-3 text-xs font-mono text-text-primary leading-relaxed whitespace-pre-wrap border border-border/50">{testResult}</div>
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}

// ─── Scene prompt section ────────────────────────────────────────────────────

function ScenePromptSection({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Section title="Prompt de generación de escena (imagen)">
      <p className="text-xs text-text-muted">
        Plantilla que se envía al LLM para generar la descripción visual de una escena.
        Usa <code className="bg-surface-3 px-1 rounded text-accent">{'{{characters}}'}</code> y{' '}
        <code className="bg-surface-3 px-1 rounded text-accent">{'{{messages}}'}</code> como variables.
      </p>
      <RestorablePrompt
        settingsKey="sceneImagePrompt"
        value={value}
        onChange={onChange}
        rows={12}
        mono
        hint="Incluye instrucciones de posicionamiento (on the left / in the center / on the right) para mejorar escenas con varios personajes."
      />
    </Section>
  );
}

// ─── Background prompt section ───────────────────────────────────────────────

function BackgroundPromptSection({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Section title="Prompt de mejora de fondos de chat">
      <p className="text-xs text-text-muted">
        Plantilla que se envía al LLM al pulsar "Mejorar prompt" en el generador de fondos de la
        ventana de chat. Usa <code className="bg-surface-3 px-1 rounded text-accent">{'{{prompt}}'}</code>{' '}
        como variable para la descripción escrita por el usuario.
      </p>
      <RestorablePrompt
        settingsKey="backgroundImagePrompt"
        value={value}
        onChange={onChange}
        rows={10}
        mono
      />
    </Section>
  );
}

function SaveBar({ onSave, isPending, isSuccess }: { onSave: () => void; isPending: boolean; isSuccess: boolean }) {
  return (
    <div className="flex justify-end pt-2">
      <button
        onClick={onSave}
        disabled={isPending}
        className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
      >
        {isPending ? (
          <Loader size={13} className="animate-spin" />
        ) : isSuccess ? (
          <CheckCircle2 size={13} />
        ) : null}
        {isSuccess ? 'Guardado' : 'Guardar'}
      </button>
    </div>
  );
}

// ─── Fast LLM section ────────────────────────────────────────────────────────

function FastLlmSection({
  providers, enabled, providerId, modelId, debugMode, analysisPrompt,
  onEnabledChange, onProviderChange, onModelChange, onDebugModeChange, onAnalysisPromptChange,
}: {
  providers: Provider[];
  enabled: boolean;
  providerId: string | null;
  modelId: string | null;
  debugMode: boolean;
  analysisPrompt: string;
  onEnabledChange: (v: boolean) => void;
  onProviderChange: (v: string | null) => void;
  onModelChange: (v: string | null) => void;
  onDebugModeChange: (v: boolean) => void;
  onAnalysisPromptChange: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      <ToggleRow
        label="Activar LLM Rápido"
        description="Analiza cada respuesta para generar memorias y actualizar afinidades automáticamente"
        checked={enabled}
        onChange={onEnabledChange}
      />

      {enabled && (
        <>
          <DefaultModelSection
            providers={providers}
            defaultProviderId={providerId}
            defaultModelId={modelId}
            onProviderChange={onProviderChange}
            onModelChange={onModelChange}
          />

          <ToggleRow
            label="Modo debug"
            description="Muestra el análisis del LLM Rápido debajo de cada mensaje del personaje"
            checked={debugMode}
            onChange={onDebugModeChange}
          />

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-text-secondary">
                Prompt de análisis
              </label>
              <RestoreButton settingsKey="fastLlmAnalysisPrompt" onRestore={onAnalysisPromptChange} />
            </div>
            <p className="text-[10px] text-text-muted">
              Variables disponibles:{' '}
              <code className="bg-surface-3 px-1 rounded text-accent">{'{{PERSONAJES}}'}</code>{' '}
              <code className="bg-surface-3 px-1 rounded text-accent">{'{{MENSAJE_JUGADOR}}'}</code>{' '}
              <code className="bg-surface-3 px-1 rounded text-accent">{'{{RESPUESTA}}'}</code>
            </p>
            <textarea
              value={analysisPrompt}
              onChange={(e) => onAnalysisPromptChange(e.target.value)}
              rows={12}
              className="w-full rounded-lg px-3 py-2 text-xs bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono leading-relaxed"
              placeholder="Prompt de análisis del LLM Rápido…"
            />
          </div>
        </>
      )}
    </div>
  );
}

// ─── Default Model section ───────────────────────────────────────────────────

function DefaultModelSection({
  providers,
  defaultProviderId,
  defaultModelId,
  onProviderChange,
  onModelChange,
  hideDescription,
}: {
  providers: Provider[];
  defaultProviderId: string | null;
  defaultModelId: string | null;
  onProviderChange: (v: string | null) => void;
  onModelChange: (v: string | null) => void;
  hideDescription?: boolean;
}) {
  const [models, setModels] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(false);

  async function loadModels(providerId: string) {
    setLoading(true);
    setModels([]);
    try {
      const list = await providersApi.listModels(providerId);
      setModels(list.map((m) => m.id));
    } catch {
      setModels([]);
    } finally {
      setLoading(false);
    }
  }

  function handleProviderChange(pid: string) {
    const val = pid || null;
    onProviderChange(val);
    onModelChange(null);
    if (val) loadModels(val);
    else setModels([]);
  }

  return (
    <div className="space-y-3">
      {!hideDescription && (
        <p className="text-xs text-text-muted">
          Usado cuando el personaje no tiene un provider/modelo propio configurado.
        </p>
      )}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-text-secondary">Provider</label>
        <select
          value={defaultProviderId ?? ''}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="w-full rounded-lg px-3 py-2 text-sm border border-border focus:outline-none focus:ring-1 focus:ring-accent"
          style={{ background: 'var(--surface-1)', color: 'var(--text-primary)' }}
        >
          <option value="">— ninguno —</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
          ))}
        </select>
      </div>

      {defaultProviderId && (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-text-secondary">Modelo</label>
          {loading ? (
            <p className="text-xs text-text-muted animate-pulse">Cargando modelos...</p>
          ) : models.length > 0 ? (
            <select
              value={defaultModelId ?? ''}
              onChange={(e) => onModelChange(e.target.value || null)}
              className="w-full rounded-lg px-3 py-2 text-sm border border-border focus:outline-none focus:ring-1 focus:ring-accent"
              style={{ background: 'var(--surface-1)', color: 'var(--text-primary)' }}
            >
              <option value="">— elige un modelo —</option>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input
              value={defaultModelId ?? ''}
              onChange={(e) => onModelChange(e.target.value || null)}
              placeholder="ej. llama3.2, mistral, gemma2..."
              className="w-full rounded-lg px-3 py-2 text-sm border border-border focus:outline-none focus:ring-1 focus:ring-accent bg-transparent"
              style={{ color: 'var(--text-primary)' }}
            />
          )}
          {!loading && models.length === 0 && (
            <p className="text-[10px] text-text-muted">
              Provider no conectado — escribe el nombre del modelo manualmente.
            </p>
          )}
          <button
            onClick={() => loadModels(defaultProviderId)}
            className="text-xs text-accent hover:underline text-left w-fit"
          >
            Recargar modelos
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Providers section ────────────────────────────────────────────────────────

const PROVIDER_TYPES = [
  { value: 'ollama',      label: 'Ollama',          url: 'http://localhost:11434',         hint: 'ollama serve' },
  { value: 'lmstudio',   label: 'LM Studio',        url: 'http://localhost:1234/v1',       hint: 'Enable local server in LM Studio' },
  { value: 'mlx',        label: 'MLX (Apple)',       url: 'http://localhost:8000/v1',       hint: 'Puerto habitual: 8000 (oMLX) o 8080 (mlx_lm.server).  Si el servidor pide API Key, introdúcela abajo' },
  { value: 'openai',     label: 'OpenAI',            url: 'https://api.openai.com/v1',     hint: 'Requires API key' },
  { value: 'openrouter', label: 'OpenRouter',        url: 'https://openrouter.ai/api/v1',  hint: 'Requires API key' },
  { value: 'kobold',     label: 'KoboldCpp',         url: 'http://localhost:5001',         hint: 'koboldcpp --host 0.0.0.0' },
  { value: 'oobabooga',  label: 'Oobabooga',         url: 'http://localhost:5000/v1',      hint: 'Enable --api flag' },
  { value: 'custom',     label: 'Custom (OpenAI-compatible)', url: 'http://localhost:8080/v1', hint: 'Any OpenAI-compatible endpoint' },
];

function ProvidersSection({ providers }: { providers: Provider[] }) {
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();

  const DEFAULT_NEW: CreateProviderDto = {
    name: '',
    type: 'ollama',
    baseUrl: 'http://localhost:11434',
    apiKey: null,
    defaultModel: null,
    isEnabled: true,
    config: {},
  };
  const [newProv, setNewProv] = useState<CreateProviderDto>(DEFAULT_NEW);

  const create = useMutation({
    mutationFn: () => providersApi.create(newProv),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['providers'] }); setAdding(false); setNewProv(DEFAULT_NEW); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => providersApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">LLM Providers</h3>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus size={13} /> Add Provider
        </Button>
      </div>

      {/* Add form */}
      {adding && (
        <div className="rounded-xl border border-accent/40 p-4 space-y-3 animate-slide-up"
          style={{ background: 'var(--surface-2)' }}>
          <h4 className="text-sm font-medium">New Provider</h4>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Name" value={newProv.name} onChange={(e) => setNewProv((p) => ({ ...p, name: e.target.value }))} placeholder="My Ollama" />
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-text-secondary">Type</label>
              <select
                value={newProv.type}
                onChange={(e) => {
                  const t = PROVIDER_TYPES.find((p) => p.value === e.target.value);
                  setNewProv((p) => ({ ...p, type: e.target.value as Provider['type'], baseUrl: t?.url ?? p.baseUrl }));
                }}
                className="rounded-lg px-3 py-2 text-sm bg-surface-1 border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              >
                {PROVIDER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          </div>
          {/* Hint for the selected provider type */}
          {(() => {
            const hint = PROVIDER_TYPES.find((t) => t.value === newProv.type)?.hint;
            return hint ? (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs text-text-muted"
                style={{ background: 'var(--surface-3)' }}>
                <span className="font-mono mt-0.5">$</span>
                <span>{hint}</span>
              </div>
            ) : null;
          })()}
          <Input label="Base URL" value={newProv.baseUrl} onChange={(e) => setNewProv((p) => ({ ...p, baseUrl: e.target.value }))} placeholder="http://localhost:11434" />
          <Input label="API Key (optional)" value={newProv.apiKey ?? ''} onChange={(e) => setNewProv((p) => ({ ...p, apiKey: e.target.value || null }))} type="password" placeholder="sk-..." />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={() => create.mutate()} loading={create.isPending}>Add Provider</Button>
          </div>
        </div>
      )}

      {/* Provider list */}
      <div className="space-y-2">
        {providers.map((p) => (
          <ProviderRow key={p.id} provider={p} onDelete={() => remove.mutate(p.id)} />
        ))}
      </div>
    </div>
  );
}

function ProviderRow({ provider, onDelete }: { provider: Provider; onDelete: () => void }) {
  const [validating, setValidating] = useState(false);
  const [valid, setValid] = useState<boolean | null>(null);
  const [validError, setValidError] = useState<string | null>(null);

  async function validate() {
    setValidating(true);
    setValidError(null);
    try {
      const result = await providersApi.validate(provider.id);
      setValid(result.valid);
      setValidError(result.valid ? null : (result.error ?? 'Conexión fallida'));
    } catch (err) {
      setValid(false);
      setValidError(err instanceof Error ? err.message : 'Error al conectar');
    } finally {
      setValidating(false);
    }
  }

  return (
    <div className="rounded-xl border border-border overflow-hidden"
      style={{ background: 'var(--surface-2)' }}>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{provider.name}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-accent-muted text-accent">{provider.type}</span>
            {!provider.isEnabled && <span className="px-1.5 py-0.5 rounded text-[10px] bg-surface-3 text-text-muted">disabled</span>}
          </div>
          <p className="text-xs text-text-muted font-mono truncate">{provider.baseUrl}</p>
        </div>
        <div className="flex items-center gap-1">
          {valid === true  && <Check size={14} className="text-emerald-400" />}
          {valid === false && <X    size={14} className="text-red-400" />}
          <button onClick={validate} disabled={validating}
            className="p-1.5 rounded hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
            title="Probar conexión">
            <RefreshCw size={13} className={validating ? 'animate-spin' : ''} />
          </button>
          <button onClick={onDelete}
            className="p-1.5 rounded hover:bg-red-500/10 text-text-muted hover:text-red-400 transition-colors"
            title="Eliminar">
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {/* Error detail shown below the row after a failed validate */}
      {validError && (
        <div className="px-4 py-2 border-t border-border flex items-start gap-2"
          style={{ background: 'var(--surface-3)' }}>
          <AlertCircle size={12} className="text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-red-400 leading-relaxed">{validError}</p>
        </div>
      )}
    </div>
  );
}

// ─── Profile section ─────────────────────────────────────────────────────────

// ─── Narration Style Section ──────────────────────────────────────────────────

function NarrationStyleSection() {
  const { user, setAuth } = useAuthStore();
  const current = (user?.narrationStyle ?? 'normal') as 'normal' | 'medium' | 'short';
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);

  async function select(style: 'normal' | 'medium' | 'short') {
    if (style === current) return;
    setSaving(true);
    try {
      const data = await authApi.updateProfile({ narrationStyle: style });
      setAuth(data.token, data.user);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  const options: { id: 'normal' | 'medium' | 'short'; label: string; desc: string }[] = [
    { id: 'normal', label: 'Normal',   desc: 'Respuestas completas y detalladas (por defecto)' },
    { id: 'medium', label: 'Moderado', desc: 'Respuestas más cortas, equilibradas' },
    { id: 'short',  label: 'Corto',    desc: 'Respuestas concisas y directas' },
  ];

  return (
    <Section title="Estilo de narración">
      <p className="text-xs text-text-muted mb-3 leading-relaxed">
        Controla la longitud de las respuestas del narrador. El administrador puede personalizar qué se le dice al modelo para cada estilo.
      </p>
      <div className="flex gap-2">
        {options.map((opt) => (
          <button
            key={opt.id}
            disabled={saving}
            onClick={() => select(opt.id)}
            title={opt.desc}
            className={`flex-1 py-2.5 px-3 rounded-lg text-sm border transition-colors ${
              current === opt.id
                ? 'border-accent bg-accent-muted text-accent font-medium'
                : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-text-muted mt-2 italic">
        {options.find(o => o.id === current)?.desc}
        {saved && <span className="ml-2 text-emerald-400">✓ Guardado</span>}
      </p>
    </Section>
  );
}

function ProfileSection() {
  const { user, setAuth } = useAuthStore();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [appearance,  setAppearance]  = useState(user?.appearance  ?? '');
  const [saved, setSaved] = useState(false);

  // Avatar upload & crop
  const [cropSrc,     setCropSrc]     = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // Inspiration modal state
  const [inspiredUrl,    setInspiredUrl]    = useState<string | null>(null);
  const [inspirationPrompt, setInspirationPrompt] = useState('');
  const [showInspirationModal, setShowInspirationModal] = useState(false);

  const isDirty =
    displayName.trim() !== (user?.displayName ?? '') ||
    appearance          !== (user?.appearance  ?? '');

  // ── mutations ──────────────────────────────────────────────────────────────
  const updateMut = useMutation({
    mutationFn: () => authApi.updateProfile({ displayName: displayName.trim(), appearance }),
    onSuccess: (data) => { setAuth(data.token, data.user); setSaved(true); setTimeout(() => setSaved(false), 2000); },
  });

  const uploadAvatarMut = useMutation({
    mutationFn: (file: File) => authApi.uploadAvatar(file),
    onSuccess: (data) => { setAuth(data.token, data.user); setPendingFile(null); setCropSrc(null); },
  });

  const deleteAvatarMut = useMutation({
    mutationFn: () => authApi.deleteAvatar(),
    onSuccess: (data) => setAuth(data.token, data.user),
  });

  const generateDescMut = useMutation({
    mutationFn: () => authApi.generateDescription(),
    onSuccess: ({ description }) => { setAppearance(description); setSaved(false); },
  });

  const inspirationMut = useMutation({
    mutationFn: (prompt?: string) => authApi.generateInspiration(prompt),
    onSuccess: ({ imageUrl }) => { setInspiredUrl(imageUrl); },
  });

  // ── avatar upload — open crop modal first ─────────────────────────────────
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    const url = URL.createObjectURL(file);
    setCropSrc(url);
    e.target.value = ''; // reset so same file can be picked again
  }

  async function handleCropConfirm(blob: Blob) {
    const croppedFile = new File([blob], pendingFile?.name ?? 'avatar.jpg', { type: blob.type });
    await uploadAvatarMut.mutateAsync(croppedFile);
    if (cropSrc?.startsWith('blob:')) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
  }

  // ── use inspired image as avatar ──────────────────────────────────────────
  function handleUseInspiredAsAvatar() {
    if (!inspiredUrl) return;
    setCropSrc(inspiredUrl);
    setPendingFile(new File([], 'inspired.png', { type: 'image/png' }));
    setShowInspirationModal(false);
  }

  const avatarSrc = user?.avatar ? `${user.avatar}?t=${user.updatedAt}` : null;

  return (
    <div className="space-y-6">
      {/* ── Avatar ──────────────────────────────────────────────────────── */}
      <Section title="Foto de perfil">
        <div className="flex items-start gap-5">
          {/* Photo */}
          <div className="relative flex-shrink-0">
            <div
              className="w-24 h-24 rounded-full border-2 border-border overflow-hidden flex items-center justify-center"
              style={{ background: 'var(--surface-2)' }}
            >
              {avatarSrc ? (
                <img src={avatarSrc} alt="avatar" className="w-full h-full object-cover" />
              ) : (
                <UserCircle size={40} className="text-text-muted" />
              )}
            </div>
            {/* Camera badge */}
            <label
              htmlFor="profile-avatar-upload"
              className="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-accent flex items-center justify-center cursor-pointer border-2 border-surface-1 hover:bg-accent-hover transition-colors"
              title="Subir foto"
            >
              <Camera size={12} className="text-white" />
            </label>
            <input
              id="profile-avatar-upload"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 pt-1">
            <label
              htmlFor="profile-avatar-upload"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-border text-text-secondary hover:text-text-primary hover:border-accent/50 cursor-pointer transition-colors"
            >
              <Upload size={12} /> Subir foto
            </label>

            {avatarSrc && (
              <>
                <button
                  onClick={() => setShowInspirationModal(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 transition-colors"
                  title="Generar nueva imagen manteniendo tu apariencia (FaceID)"
                >
                  <FlaskConical size={12} /> Inspiración
                </button>
                <button
                  onClick={() => deleteAvatarMut.mutate()}
                  disabled={deleteAvatarMut.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 size={12} /> Eliminar foto
                </button>
              </>
            )}

            {(uploadAvatarMut.isPending || deleteAvatarMut.isPending) && (
              <span className="text-[11px] text-text-muted flex items-center gap-1">
                <Loader size={10} className="animate-spin" /> Procesando…
              </span>
            )}
            {uploadAvatarMut.isError && (
              <span className="text-[11px] text-red-400">{(uploadAvatarMut.error as Error).message}</span>
            )}
          </div>
        </div>
      </Section>

      {/* ── Display name ────────────────────────────────────────────────── */}
      <Section title="Nombre para la IA">
        <p className="text-xs text-text-muted mb-3">
          Este nombre será usado por los personajes para referirse a ti durante las conversaciones.
        </p>
        <Input
          value={displayName}
          onChange={(e) => { setDisplayName(e.target.value); setSaved(false); }}
          placeholder="Tu nombre"
        />
      </Section>

      {/* ── Appearance description ──────────────────────────────────────── */}
      <Section title="Descripción de apariencia">
        <p className="text-xs text-text-muted mb-3">
          Descripción visual (aspecto físico, ropa habitual, rasgos). Se incluirá al generar imágenes
          de escena para que puedas aparecer en ellas.
        </p>
        <div className="relative">
          <textarea
            value={appearance}
            onChange={(e) => { setAppearance(e.target.value); setSaved(false); }}
            rows={5}
            placeholder="Ej: Human male, early 30s, short dark hair, blue eyes, casual jeans and grey hoodie, athletic build..."
            className="w-full rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono leading-relaxed"
          />
        </div>
        <div className="flex justify-end mt-2">
          <button
            onClick={() => generateDescMut.mutate()}
            disabled={generateDescMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-violet-500/40 text-violet-400 hover:bg-violet-500/10 disabled:opacity-50 transition-colors"
            title="La IA genera una descripción de apariencia optimizada para imágenes"
          >
            {generateDescMut.isPending
              ? <><Loader size={11} className="animate-spin" /> Generando…</>
              : <><Wand2 size={11} /> Describir con IA</>}
          </button>
        </div>
        {generateDescMut.isError && (
          <p className="text-xs text-red-400 mt-1">{(generateDescMut.error as Error).message}</p>
        )}
      </Section>

      {/* ── Save bar ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between pt-1">
        {updateMut.isError && (
          <p className="text-xs text-red-400">{(updateMut.error as Error).message}</p>
        )}
        <div className="ml-auto">
          <Button
            size="sm"
            onClick={() => updateMut.mutate()}
            disabled={updateMut.isPending || !displayName.trim() || !isDirty}
          >
            {saved
              ? <><Check size={13} /> Guardado</>
              : updateMut.isPending
              ? <><Loader size={13} className="animate-spin" /> Guardando…</>
              : 'Guardar perfil'}
          </Button>
        </div>
      </div>

      {/* ── Crop modal ──────────────────────────────────────────────────── */}
      {cropSrc && (
        <AvatarCropModal
          imageSrc={cropSrc}
          onConfirm={handleCropConfirm}
          onClose={() => { setCropSrc(null); setPendingFile(null); }}
        />
      )}

      {/* ── Inspiration modal ───────────────────────────────────────────── */}
      {showInspirationModal && (
        <InspirationModal
          defaultPrompt={appearance}
          isGenerating={inspirationMut.isPending}
          error={inspirationMut.isError ? (inspirationMut.error as Error).message : null}
          resultUrl={inspiredUrl}
          onGenerate={(prompt) => { setInspiredUrl(null); inspirationMut.mutate(prompt); }}
          onUseAsAvatar={handleUseInspiredAsAvatar}
          onClose={() => { setShowInspirationModal(false); setInspiredUrl(null); }}
          prompt={inspirationPrompt}
          onPromptChange={setInspirationPrompt}
        />
      )}
    </div>
  );
}

// ── Inspiration modal ──────────────────────────────────────────────────────────
interface InspirationModalProps {
  defaultPrompt: string;
  isGenerating: boolean;
  error: string | null;
  resultUrl: string | null;
  prompt: string;
  onPromptChange: (v: string) => void;
  onGenerate: (prompt?: string) => void;
  onUseAsAvatar: () => void;
  onClose: () => void;
}

function InspirationModal({
  defaultPrompt, isGenerating, error, resultUrl,
  prompt, onPromptChange, onGenerate, onUseAsAvatar, onClose,
}: InspirationModalProps) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border flex flex-col animate-slide-up overflow-hidden"
        style={{ background: 'var(--surface-1)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <FlaskConical size={15} className="text-amber-400" />
            <div>
              <p className="font-semibold text-sm">Inspiración (BETA)</p>
              <p className="text-[10px] text-text-muted mt-0.5">
                Genera una imagen nueva manteniendo tu apariencia
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary">
            <X size={15} />
          </button>
        </div>

        <div className="p-5 space-y-4 flex-1 overflow-y-auto">
          {/* Prompt */}
          <div>
            <label className="text-xs font-medium text-text-secondary block mb-1.5">
              Descripción / prompt de imagen
            </label>
            <textarea
              value={prompt || defaultPrompt}
              onChange={(e) => onPromptChange(e.target.value)}
              rows={4}
              placeholder={defaultPrompt || 'Describe la imagen que quieres generar…'}
              className="w-full rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-none font-mono"
            />
            <p className="text-[10px] text-text-muted mt-1">
              Deja vacío para usar tu descripción de apariencia guardada.
            </p>
          </div>

          {/* Result image */}
          {resultUrl && (
            <div className="rounded-xl overflow-hidden border border-border">
              <img src={resultUrl} alt="Imagen generada" className="w-full object-cover" />
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-border">
          {resultUrl ? (
            <button
              onClick={onUseAsAvatar}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 transition-colors"
            >
              <Check size={13} /> Usar como avatar
            </button>
          ) : <div />}
          <button
            onClick={() => onGenerate(prompt || undefined)}
            disabled={isGenerating}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 transition-colors"
          >
            {isGenerating
              ? <><Loader size={13} className="animate-spin" /> Generando…</>
              : <><Sparkles size={13} /> {resultUrl ? 'Regenerar' : 'Generar'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Users section ────────────────────────────────────────────────────────────

// Clase base para todos los inputs/selects de esta sección — igual que el componente Input oficial
const fieldCls = 'w-full rounded-lg px-3 py-1.5 text-sm bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent transition-colors';

type UpdateUserPayload = { username?: string; password?: string; displayName?: string; role?: 'admin' | 'user' };

function UsersSection() {
  const qc = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);

  const { data: userList = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
  });

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', displayName: '', role: 'user' as 'admin' | 'user' });
  const [formError, setFormError] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ username: '', password: '', displayName: '', role: 'user' as 'admin' | 'user' });
  const [editError, setEditError] = useState('');
  const [assignId, setAssignId] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: () => usersApi.create({ ...form, role: form.role }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); setCreating(false); setForm({ username: '', password: '', displayName: '', role: 'user' }); setFormError(''); },
    onError: (e: Error) => setFormError(e.message),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateUserPayload }) =>
      usersApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); setEditId(null); setEditError(''); },
    onError: (e: Error) => setEditError(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => usersApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => usersApi.setActive(id, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Users size={16} />
            Gestión de usuarios
          </h3>
          <p className="text-xs text-text-muted mt-0.5">Crea y gestiona las cuentas de acceso</p>
        </div>
        <Button size="sm" onClick={() => { setCreating(true); setFormError(''); }}>
          <Plus size={14} className="mr-1" />
          Nuevo usuario
        </Button>
      </div>

      {/* Create form */}
      {creating && (
        <div className="border border-border rounded-xl p-4 space-y-3" style={{ background: 'var(--surface-1)' }}>
          <h4 className="text-sm font-medium text-text-primary">Nuevo usuario</h4>
          {formError && <p className="text-xs text-red-400">{formError}</p>}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-text-muted">Usuario</label>
              <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} className={fieldCls} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-muted">Nombre visible</label>
              <input value={form.displayName} onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))} className={fieldCls} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-muted">Contraseña</label>
              <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} className={fieldCls} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-muted">Rol</label>
              <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as 'admin' | 'user' }))} className={fieldCls}>
                <option value="user">Usuario</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={() => createMut.mutate()} disabled={createMut.isPending || !form.username || !form.password || !form.displayName}>
              {createMut.isPending ? 'Creando…' : 'Crear'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setFormError(''); }}>Cancelar</Button>
          </div>
        </div>
      )}

      {/* User list */}
      {isLoading ? (
        <p className="text-sm text-text-muted text-center py-4">Cargando…</p>
      ) : (
        <div className="space-y-2">
          {userList.map((u) => (
            <div key={u.id} className="border border-border rounded-xl p-4" style={{ background: 'var(--surface-1)' }}>
              {editId === u.id ? (
                <div className="space-y-3">
                  {editError && (
                    <p className="text-xs text-red-400 bg-red-500/8 border border-red-500/20 rounded-lg px-3 py-2">{editError}</p>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs text-text-muted">Nombre visible</label>
                      <input value={editForm.displayName} onChange={e => setEditForm(f => ({ ...f, displayName: e.target.value }))} className={fieldCls} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-text-muted">Usuario (login)</label>
                      <input
                        value={editForm.username}
                        onChange={e => setEditForm(f => ({ ...f, username: e.target.value }))}
                        className={fieldCls}
                        placeholder="Sin cambios"
                        autoComplete="off"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-text-muted">Nueva contraseña</label>
                      <input
                        type="password"
                        value={editForm.password}
                        onChange={e => setEditForm(f => ({ ...f, password: e.target.value }))}
                        placeholder="Sin cambios"
                        className={fieldCls}
                        autoComplete="new-password"
                      />
                    </div>
                    {u.id !== 'user-admin' && (
                      <div className="space-y-1">
                        <label className="text-xs text-text-muted">Rol</label>
                        <select value={editForm.role} onChange={e => setEditForm(f => ({ ...f, role: e.target.value as 'admin' | 'user' }))} className={fieldCls}>
                          <option value="user">Usuario</option>
                          <option value="admin">Admin</option>
                        </select>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => {
                      setEditError('');
                      const data: UpdateUserPayload = {};
                      if (editForm.displayName.trim()) data.displayName = editForm.displayName.trim();
                      if (editForm.username.trim()) data.username = editForm.username.trim();
                      if (editForm.password) data.password = editForm.password;
                      if (u.id !== 'user-admin') data.role = editForm.role;
                      if (Object.keys(data).length === 0) { setEditId(null); return; }
                      updateMut.mutate({ id: u.id, data });
                    }} disabled={updateMut.isPending || !editForm.displayName.trim()}>
                      {updateMut.isPending ? 'Guardando…' : 'Guardar'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setEditId(null); setEditError(''); }}>Cancelar</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      u.role === 'admin' ? 'bg-accent/20 text-accent' : 'bg-surface-2 text-text-muted'
                    }`}>
                      {u.role === 'admin' ? <Shield size={14} /> : <UserCircle size={14} />}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-text-primary">{u.displayName}
                        {u.id === currentUser?.id && <span className="ml-1.5 text-xs text-accent">(tú)</span>}
                      </p>
                      <p className="text-xs text-text-muted">@{u.username} · {u.role === 'admin' ? 'Administrador' : 'Usuario'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {u.id !== currentUser?.id && (
                      <button
                        onClick={() => toggleActive.mutate({ id: u.id, active: !u.isActive })}
                        className={`px-2 py-0.5 rounded text-xs transition-colors ${
                          u.isActive
                            ? 'bg-green-500/15 text-green-400 hover:bg-red-500/15 hover:text-red-400'
                            : 'bg-red-500/15 text-red-400 hover:bg-green-500/15 hover:text-green-400'
                        }`}
                        title={u.isActive ? 'Desactivar' : 'Activar'}
                      >
                        {u.isActive ? 'Activo' : 'Inactivo'}
                      </button>
                    )}
                    {/* Assignment button — only for non-admin users */}
                    {u.role === 'user' && (
                      <button
                        onClick={() => { setAssignId(assignId === u.id ? null : u.id); setEditId(null); }}
                        className={`p-1.5 rounded transition-colors ${assignId === u.id ? 'text-accent bg-accent/10' : 'text-text-muted hover:text-text-primary hover:bg-white/5'}`}
                        title="Asignaciones de contenido"
                      >
                        <Link2 size={13} />
                      </button>
                    )}
                    <button
                      onClick={() => { setEditId(u.id); setEditForm({ username: '', password: '', displayName: u.displayName, role: u.role }); setEditError(''); setAssignId(null); }}
                      className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-white/5 transition-colors"
                      title="Editar usuario"
                    >
                      <Pencil size={13} />
                    </button>
                    {u.id !== 'user-admin' && u.id !== currentUser?.id && (
                      <button
                        onClick={() => { if (confirm(`¿Eliminar usuario "${u.displayName}"?`)) deleteMut.mutate(u.id); }}
                        className="p-1.5 rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        title="Eliminar"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              )}
              {/* Assignments panel — rendered inside the card, below both normal row and edit form */}
              {assignId === u.id && editId !== u.id && (
                <UserAssignmentsPanel userId={u.id} userName={u.displayName} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── User Assignments Panel ───────────────────────────────────────────────────

function UserAssignmentsPanel({ userId, userName }: { userId: string; userName: string }) {
  const qc = useQueryClient();

  // All content (admin sees everything)
  const { data: allChars = [] }   = useQuery({ queryKey: ['characters'], queryFn: () => charactersApi.list() });
  const { data: allStories = [] } = useQuery({ queryKey: ['stories'],    queryFn: () => storiesApi.list() });

  // Current assignments for this user
  const { data: charAssign, isLoading: loadingChars } = useQuery({
    queryKey: ['user-chars', userId],
    queryFn: () => usersApi.getCharacterIds(userId),
  });
  const { data: storyAssign, isLoading: loadingStories } = useQuery({
    queryKey: ['user-stories', userId],
    queryFn: () => usersApi.getStoryIds(userId),
  });

  const [selChars, setSelChars]     = useState<Set<string>>(new Set());
  const [selStories, setSelStories] = useState<Set<string>>(new Set());
  const [saving, setSaving]         = useState(false);
  const [saved, setSaved]           = useState(false);

  // Sync remote data into local state once loaded
  useEffect(() => {
    if (charAssign?.characterIds) setSelChars(new Set(charAssign.characterIds));
  }, [charAssign]);
  useEffect(() => {
    if (storyAssign?.storyIds) setSelStories(new Set(storyAssign.storyIds));
  }, [storyAssign]);

  function toggleChar(id: string) {
    setSelChars((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    setSaved(false);
  }
  function toggleStory(id: string) {
    setSelStories((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await usersApi.setCharacterIds(userId, [...selChars]);
      await usersApi.setStoryIds(userId, [...selStories]);
      qc.invalidateQueries({ queryKey: ['user-chars', userId] });
      qc.invalidateQueries({ queryKey: ['user-stories', userId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  const isLoading = loadingChars || loadingStories;

  return (
    <div className="mt-3 pt-3 border-t border-border">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
          <Link2 size={12} className="text-accent" />
          Contenido accesible para <span className="text-text-primary font-semibold">{userName}</span>
        </p>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors bg-accent hover:bg-accent-hover text-white disabled:opacity-50"
        >
          {saving ? <><Loader size={11} className="animate-spin" /> Guardando…</> : saved ? <><Check size={11} /> Guardado</> : 'Guardar'}
        </button>
      </div>

      {isLoading ? (
        <p className="text-xs text-text-muted py-2">Cargando…</p>
      ) : (
        <div className="grid grid-cols-2 gap-4">

          {/* Characters column */}
          <div>
            <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2 flex items-center gap-1">
              <UserCircle size={11} /> Personajes ({selChars.size}/{allChars.length})
            </p>
            <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
              {allChars.length === 0 && <p className="text-xs text-text-muted">Sin personajes</p>}
              {allChars.map((c) => (
                <label key={c.id} className="flex items-center gap-2 py-1 px-2 rounded-lg cursor-pointer hover:bg-white/5 transition-colors">
                  <input
                    type="checkbox"
                    checked={selChars.has(c.id)}
                    onChange={() => toggleChar(c.id)}
                    className="accent-[var(--accent)] w-3.5 h-3.5 rounded flex-shrink-0"
                  />
                  <span className={`text-xs truncate ${selChars.has(c.id) ? 'text-text-primary' : 'text-text-muted'}`}>
                    {c.name}
                  </span>
                  {c.userId === userId && (
                    <span className="ml-auto text-[10px] text-accent flex-shrink-0">propio</span>
                  )}
                </label>
              ))}
            </div>
          </div>

          {/* Stories column */}
          <div>
            <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2 flex items-center gap-1">
              <BookOpen size={11} /> Historias ({selStories.size}/{allStories.length})
            </p>
            <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
              {allStories.length === 0 && <p className="text-xs text-text-muted">Sin historias</p>}
              {allStories.map((s) => (
                <label key={s.id} className="flex items-center gap-2 py-1 px-2 rounded-lg cursor-pointer hover:bg-white/5 transition-colors">
                  <input
                    type="checkbox"
                    checked={selStories.has(s.id)}
                    onChange={() => toggleStory(s.id)}
                    className="accent-[var(--accent)] w-3.5 h-3.5 rounded flex-shrink-0"
                  />
                  <span className={`text-xs truncate ${selStories.has(s.id) ? 'text-text-primary' : 'text-text-muted'}`}>
                    {s.name}
                  </span>
                  {s.userId === userId && (
                    <span className="ml-auto text-[10px] text-accent flex-shrink-0">propia</span>
                  )}
                </label>
              ))}
            </div>
          </div>

        </div>
      )}
      <p className="text-[10px] text-text-muted mt-2">
        Los administradores siempre ven todo el contenido. Los personajes e historias propios del usuario siempre son visibles independientemente de esta lista.
      </p>
    </div>
  );
}

// ─── Image Provider Section ────────────────────────────────────────────────────

type ImageProviderType = 'comfyui' | 'pollinations' | 'gemini' | 'fal' | 'bzcomfy';

const IMAGE_PROVIDERS: { value: ImageProviderType; label: string; badge: string; desc: string }[] = [
  { value: 'comfyui',      label: 'ComfyUI (local)',          badge: 'Local',    desc: 'Máximo control y calidad. Requiere instalación local. Soporta FaceID.' },
  { value: 'bzcomfy',      label: 'bzComfy (remoto)',         badge: 'Local',    desc: 'ComfyUI remoto vía bzComfy proxy. Usa el token M2M para conectarse desde el VPS. Soporta FaceID.' },
  { value: 'pollinations', label: 'Pollinations.ai',          badge: 'Gratis',   desc: 'Completamente gratis y sin API key. FLUX.1, flux-realism, flux-anime…' },
  { value: 'gemini',       label: 'Google Gemini Imagen 4',   badge: 'De pago',  desc: 'Imagen 4 y modelos Gemini nativos. Requiere cuenta de pago en Google AI (billing activado).' },
  { value: 'fal',          label: 'Fal.ai',                   badge: 'De pago',  desc: 'FLUX.1-schnell, FLUX.1-dev, SD3… ~$0.003/img. 5 $ de créditos al registrarse.' },
];

const POLLINATIONS_MODELS = [
  { value: 'flux',          label: 'FLUX.1 (default)' },
  { value: 'flux-realism',  label: 'FLUX Realism (fotorrealista)' },
  { value: 'flux-anime',    label: 'FLUX Anime' },
  { value: 'flux-3d',       label: 'FLUX 3D' },
  { value: 'turbo',         label: 'Turbo (más rápido)' },
];

const GEMINI_MODELS = [
  { value: 'imagen-4.0-generate-001',        label: 'Imagen 4 (alta calidad)'      },
  { value: 'imagen-4.0-ultra-generate-001',  label: 'Imagen 4 Ultra (máx calidad)' },
  { value: 'imagen-4.0-fast-generate-001',   label: 'Imagen 4 Fast (más rápido)'   },
  { value: 'gemini-2.5-flash-image',         label: 'Gemini 2.5 Flash Image'       },
  { value: 'gemini-3.1-flash-image-preview', label: 'Gemini 3.1 Flash Image'       },
  { value: 'gemini-3-pro-image-preview',     label: 'Gemini 3 Pro Image'           },
  { value: 'nano-banana-pro-preview',        label: 'Nano Banana Pro'              },
];

const FAL_MODELS = [
  { value: 'fal-ai/flux/schnell',   label: 'FLUX.1 Schnell (rápido, gratis trial)' },
  { value: 'fal-ai/flux/dev',       label: 'FLUX.1 Dev (alta calidad)' },
  { value: 'fal-ai/flux-realism',   label: 'FLUX Realism (fotorrealista)' },
  { value: 'fal-ai/flux-pro/v1.1',  label: 'FLUX Pro v1.1 (profesional)' },
];

const BADGE_COLOR: Record<string, string> = {
  'Local':    'bg-blue-500/15 text-blue-300 border-blue-500/30',
  'Gratis':   'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  '1500/día': 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  'De pago':  'bg-amber-500/15 text-amber-300 border-amber-500/30',
};

function ImageProviderSection({
  draft,
  update,
}: {
  draft: Partial<AppSettings>;
  update: (k: keyof AppSettings, v: unknown) => void;
}) {
  const selected = (draft.imageProvider ?? 'comfyui') as ImageProviderType;
  const [bzWorkflows, setBzWorkflows] = React.useState<BzWorkflow[]>([]);
  const [bzWorkflowsLoading, setBzWorkflowsLoading] = React.useState(false);
  const [bzWorkflowsError, setBzWorkflowsError] = React.useState<string | null>(null);

  async function loadBzWorkflows() {
    setBzWorkflowsLoading(true);
    setBzWorkflowsError(null);
    try {
      const list = await settingsApi.bzComfyWorkflows();
      setBzWorkflows(list);
      if (list.length > 0 && !draft.bzComfyWorkflow) {
        update('bzComfyWorkflow', list[0].id);
      }
    } catch (err) {
      setBzWorkflowsError(err instanceof Error ? err.message : 'Error al conectar con bzComfy');
    } finally {
      setBzWorkflowsLoading(false);
    }
  }

  // Auto-load when switching to bzcomfy
  React.useEffect(() => {
    if (selected === 'bzcomfy' && bzWorkflows.length === 0) {
      loadBzWorkflows();
    }
  }, [selected]);

  return (
    <div className="space-y-4">
      {/* Provider selector */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-text-secondary">Proveedor</label>
        <div className="grid gap-2">
          {IMAGE_PROVIDERS.map((p) => (
            <button
              key={p.value}
              onClick={() => update('imageProvider', p.value)}
              className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-all ${
                selected === p.value
                  ? 'border-accent bg-accent/8'
                  : 'border-border hover:border-accent/40 hover:bg-white/3'
              }`}
            >
              {/* Radio dot */}
              <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                selected === p.value ? 'border-accent' : 'border-border'
              }`}>
                {selected === p.value && <div className="w-2 h-2 rounded-full bg-accent" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-text-primary">{p.label}</span>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${BADGE_COLOR[p.badge] ?? ''}`}>
                    {p.badge}
                  </span>
                </div>
                <p className="text-xs text-text-muted mt-0.5 leading-relaxed">{p.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Provider-specific config */}
      {selected === 'comfyui' && (
        <div className="space-y-3">
          <Input
            label="URL del servidor ComfyUI"
            value={draft.comfyUiUrl ?? 'http://127.0.0.1:8001'}
            onChange={(e) => update('comfyUiUrl', e.target.value)}
            placeholder="http://127.0.0.1:8001"
            hint="Local o remoto (p.ej. https://comfy.tudominio.com). FaceID solo disponible con ComfyUI."
          />
          <div className="space-y-2">
            <p className="text-[11px] font-medium text-text-secondary">
              Cloudflare Access <span className="text-text-muted font-normal">(solo si ComfyUI está protegido por un túnel)</span>
            </p>
            <Input
              label="CF-Access-Client-Id"
              value={draft.comfyUiCfClientId ?? ''}
              onChange={(e) => update('comfyUiCfClientId', e.target.value || null)}
              placeholder="xxxxxxxx.access"
              hint=""
            />
            <Input
              label="CF-Access-Client-Secret"
              value={draft.comfyUiCfClientSecret ?? ''}
              onChange={(e) => update('comfyUiCfClientSecret', e.target.value || null)}
              placeholder="yyyyyyyy…"
              hint=""
              type="password"
            />
          </div>
        </div>
      )}

      {selected === 'bzcomfy' && (
        <div className="space-y-3">
          <Input
            label="URL de bzComfy"
            value={draft.bzComfyUrl ?? 'https://bzcomfy.javierbenzo.com'}
            onChange={(e) => update('bzComfyUrl', e.target.value)}
            placeholder="https://bzcomfy.tudominio.com"
            hint="URL pública del servidor bzComfy (con Cloudflare Tunnel o similar)."
          />
          <Input
            label="API Token (M2M)"
            value={draft.bzComfyApiToken ?? ''}
            onChange={(e) => update('bzComfyApiToken', e.target.value || null)}
            placeholder="trocomocho20KIKIloco"
            hint="El mismo apiToken configurado en bzComfy/config.json. Se envía como Bearer token."
            type="password"
          />
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-text-secondary">Workflow por defecto</label>
              <button
                onClick={loadBzWorkflows}
                disabled={bzWorkflowsLoading}
                className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover disabled:opacity-50"
              >
                <RefreshCw size={11} className={bzWorkflowsLoading ? 'animate-spin' : ''} />
                Recargar
              </button>
            </div>
            {bzWorkflows.length > 0 ? (
              <select
                value={draft.bzComfyWorkflow ?? ''}
                onChange={(e) => update('bzComfyWorkflow', e.target.value)}
                className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">— Sin selección —</option>
                {bzWorkflows.map((w) => (
                  <option key={w.id} value={w.id}>{w.label}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={draft.bzComfyWorkflow ?? ''}
                onChange={(e) => update('bzComfyWorkflow', e.target.value)}
                placeholder="image_z_image_turbo"
                className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              />
            )}
            {bzWorkflowsError && (
              <p className="text-xs text-red-400">{bzWorkflowsError} — escribe el nombre manualmente.</p>
            )}
            <p className="text-xs text-text-muted">
              Nombre del workflow (sin _api.json). Pulsa "Recargar" para obtener la lista desde bzComfy.
            </p>
          </div>
        </div>
      )}

      {selected === 'pollinations' && (
        <div className="space-y-3">
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300 leading-relaxed">
            Sin registro ni API key. Tus prompts se envían a pollinations.ai — no lo uses con contenido privado.
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">Modelo</label>
            <select
              value={draft.pollinationsModel ?? 'flux'}
              onChange={(e) => update('pollinationsModel', e.target.value)}
              className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {POLLINATIONS_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {selected === 'gemini' && (
        <div className="space-y-3">
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300 leading-relaxed">
            ⚠️ La generación de imágenes con Google AI <strong>requiere billing activado</strong> (no hay tier gratuito para imágenes).
            Activa la facturación en{' '}
            <a href="https://ai.dev/projects" target="_blank" rel="noopener noreferrer"
               className="underline hover:text-amber-200">ai.dev/projects</a>
            {' '}y obtén tu API key en{' '}
            <a href="https://aistudio.google.com" target="_blank" rel="noopener noreferrer"
               className="underline hover:text-amber-200">aistudio.google.com</a>.
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">Modelo</label>
            <select
              value={draft.geminiModel ?? 'imagen-3.0-generate-001'}
              onChange={(e) => update('geminiModel', e.target.value)}
              className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {GEMINI_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-text-muted mt-1">
              Imagen 3 usa el endpoint <code className="font-mono bg-white/8 px-1 rounded">:predict</code>. Gemini 2.0 Flash usa <code className="font-mono bg-white/8 px-1 rounded">:generateContent</code>. Ambos con la misma API key.
            </p>
          </div>
          <Input
            label="API Key de Google AI Studio"
            value={draft.imageProviderApiKey ?? ''}
            onChange={(e) => update('imageProviderApiKey', e.target.value)}
            placeholder="AIza..."
            hint="La clave se almacena localmente y solo se envía a generativelanguage.googleapis.com."
          />
        </div>
      )}

      {selected === 'fal' && (
        <div className="space-y-3">
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300 leading-relaxed">
            Regístrate en{' '}
            <a href="https://fal.ai" target="_blank" rel="noopener noreferrer"
               className="underline hover:text-amber-200">fal.ai</a>
            {' '}para obtener tu API key. Incluye $5 de crédito gratuito al registrarte.
          </div>
          <Input
            label="API Key de Fal.ai"
            value={draft.imageProviderApiKey ?? ''}
            onChange={(e) => update('imageProviderApiKey', e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:xxxx..."
            hint="Encuéntrala en fal.ai/dashboard → API Keys."
          />
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">Modelo</label>
            <select
              value={draft.falModel ?? 'fal-ai/flux/schnell'}
              onChange={(e) => update('falModel', e.target.value)}
              className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {FAL_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* FaceID notice for non-ComfyUI providers */}
      {selected !== 'comfyui' && selected !== 'bzcomfy' && (
        <div className="rounded-lg border border-border bg-white/3 px-3 py-2 text-xs text-text-muted leading-relaxed">
          ℹ️ FaceID (generación con imagen de referencia) solo está disponible con ComfyUI (local o bzComfy). Con el proveedor actual, la función de "Inspiración" y el modo BETA generarán imágenes usando únicamente la descripción de texto.
        </div>
      )}
    </div>
  );
}

// ─── Stats Section ─────────────────────────────────────────────────────────────
function StatsSection() {
  const { isAdmin } = useAuthStore();
  const [filterUserId, setFilterUserId] = useState<string>('');

  // User list for the filter dropdown (admin only)
  const { data: userList = [] } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
    enabled: isAdmin,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['conversation-stats', filterUserId],
    queryFn: () => conversationsApi.stats(filterUserId || undefined),
    staleTime: 30_000,
  });

  const fmt = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return n.toLocaleString('es-ES');
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-text-muted">
        <Loader size={20} className="animate-spin mr-2" /> Calculando estadísticas…
      </div>
    );
  }

  if (!data) return null;

  const { global: g, conversations } = data;
  const cacheRatio = g.totalTokens > 0 ? Math.round(g.cachedTokens / g.totalTokens * 100) : 0;
  const selectedUser = userList.find((u) => u.id === filterUserId);

  // Sort by tokens desc
  const sorted = [...conversations].sort((a, b) => b.tokens - a.tokens);

  // Show user column when admin and not filtering (multiple users visible)
  const showUserCol = isAdmin && !filterUserId;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-primary">Estadísticas de uso</h3>

        {/* User filter — admin only */}
        {isAdmin && userList.length > 1 && (
          <div className="flex items-center gap-2">
            <Users size={13} className="text-text-muted flex-shrink-0" />
            <select
              value={filterUserId}
              onChange={(e) => setFilterUserId(e.target.value)}
              className="rounded-lg px-2.5 py-1.5 text-xs bg-surface-2 border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent transition-colors"
            >
              <option value="">Todos los usuarios</option>
              {userList.map((u) => (
                <option key={u.id} value={u.id}>{u.displayName} (@{u.username})</option>
              ))}
            </select>
            {filterUserId && (
              <button
                onClick={() => setFilterUserId('')}
                className="p-1 rounded text-text-muted hover:text-text-primary transition-colors"
                title="Quitar filtro"
              >
                <X size={13} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Global cards */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={<Zap size={16} />}
          label={selectedUser ? `Tokens — ${selectedUser.displayName}` : 'Tokens totales'}
          value={fmt(g.totalTokens)}
          sub={g.cachedTokens > 0 ? `${fmt(g.cachedTokens)} en caché (${cacheRatio}%)` : undefined}
          accent={g.cachedTokens > 0}
        />
        <StatCard
          icon={<BarChart2 size={16} />}
          label="Mensajes generados"
          value={fmt(g.totalMessages)}
          sub={`en ${g.totalConversations} conversaciones`}
        />
      </div>

      {/* Per-conversation table */}
      {sorted.length === 0 ? (
        <p className="text-sm text-text-muted text-center py-4">No hay conversaciones todavía.</p>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-surface-1/50">
                <th className="text-left px-4 py-2.5 text-text-muted font-medium">Conversación</th>
                {showUserCol && (
                  <th className="text-left px-3 py-2.5 text-text-muted font-medium">Usuario</th>
                )}
                <th className="text-right px-3 py-2.5 text-text-muted font-medium">Tokens</th>
                <th className="text-right px-3 py-2.5 text-text-muted font-medium">Caché</th>
                <th className="text-right px-4 py-2.5 text-text-muted font-medium">Msgs</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((conv, i) => {
                const convCache = conv.tokens > 0
                  ? Math.round(conv.cachedTokens / conv.tokens * 100)
                  : 0;
                return (
                  <tr
                    key={conv.id}
                    className={`border-b border-border/50 last:border-0 ${i % 2 === 0 ? '' : 'bg-surface-1/30'}`}
                  >
                    <td className="px-4 py-2.5 text-text-primary max-w-[160px]">
                      <span className="truncate block">{conv.title || 'Sin título'}</span>
                      {conv.isArchived && <span className="text-[10px] text-text-muted">(archivada)</span>}
                    </td>
                    {showUserCol && (
                      <td className="px-3 py-2.5 text-text-muted max-w-[120px]">
                        <span className="truncate block">{conv.userName ?? '—'}</span>
                      </td>
                    )}
                    <td className="px-3 py-2.5 text-right text-text-secondary tabular-nums">
                      {fmt(conv.tokens)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {conv.cachedTokens > 0 ? (
                        <span className="text-emerald-400">{convCache}%</span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-text-secondary tabular-nums">
                      {conv.messages}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon, label, value, sub, accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-1.5 ${accent ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border bg-surface-1/40'}`}>
      <div className={`flex items-center gap-1.5 text-xs ${accent ? 'text-emerald-400' : 'text-text-muted'}`}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-2xl font-semibold text-text-primary tabular-nums">{value}</div>
      {sub && <div className={`text-[11px] ${accent ? 'text-emerald-400/80' : 'text-text-muted'}`}>{sub}</div>}
    </div>
  );
}

// ─── Backup section ───────────────────────────────────────────────────────────

function BackupSection() {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Por defecto SIN imágenes: la carpeta data/images puede pesar cientos de MB y
  // hacer que el navegador no complete la descarga (el blob se bufferiza en RAM).
  // El backup solo-BD (personajes, historias, conversaciones, ajustes) pesa unos
  // MB y es lo esencial. El usuario puede marcar la casilla para el backup completo.
  const [includeImages, setIncludeImages] = useState(false);

  const [restoreFile, setRestoreFile]   = useState<File | null>(null);
  const [confirming, setConfirming]     = useState(false);
  const [restoring, setRestoring]       = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreDone, setRestoreDone]       = useState(false);
  const [restoreNeedsRestart, setRestoreNeedsRestart] = useState(false);
  const [restoreMsg, setRestoreMsg]         = useState('');
  const [restoreProgress, setRestoreProgress] = useState(0);

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  async function handleDownload() {
    setDownloading(true);
    setDownloadError(null);
    try {
      const { filename, url } = await backupApi.download(includeImages);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Error al descargar');
    } finally {
      setDownloading(false);
    }
  }

  async function handleRestore() {
    if (!restoreFile) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      setRestoreProgress(0);
      const result = await backupApi.restore(restoreFile, (pct) => setRestoreProgress(pct));
      setRestoreDone(true);
      setRestoreNeedsRestart(result.requiresRestart);
      setRestoreMsg(result.message);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'Error al restaurar');
      setRestoring(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <DatabaseBackup size={16} className="text-accent" />
          Copia de seguridad
        </h3>
        <p className="text-xs text-text-muted mt-1 leading-relaxed">
          Descarga o restaura toda la carpeta <code className="bg-white/8 px-1 rounded text-[11px]">data/</code> —
          incluye la base de datos, imágenes, workflows y modelos TTS.
        </p>
      </div>

      {/* Download card */}
      <div className="rounded-xl border border-border p-4 space-y-3" style={{ background: 'var(--surface-2)' }}>
        <div className="flex items-center gap-2">
          <HardDriveDownload size={15} className="text-accent flex-shrink-0" />
          <span className="text-sm font-semibold text-text-primary">Descargar backup</span>
        </div>
        <p className="text-xs text-text-muted leading-relaxed">
          Genera un archivo <code className="bg-white/8 px-1 rounded text-[11px]">.tar.gz</code> con
          la base de datos (personajes, historias, conversaciones y ajustes), workflows y voces TTS.
        </p>

        {/* Toggle: incluir imágenes */}
        <label className="flex items-start gap-2.5 cursor-pointer select-none rounded-lg border border-border p-2.5 hover:bg-white/3 transition-colors">
          <input
            type="checkbox"
            checked={includeImages}
            onChange={(e) => setIncludeImages(e.target.checked)}
            className="w-4 h-4 rounded mt-0.5 accent-violet-600 flex-shrink-0"
          />
          <div>
            <span className="text-sm font-medium text-text-primary">Incluir imágenes</span>
            <p className="text-[11px] text-text-muted mt-0.5 leading-relaxed">
              La carpeta de imágenes (avatares, escenas, fondos) puede pesar <strong>cientos de MB</strong>.
              Con muchas imágenes, la descarga completa puede fallar o tardar mucho. Desmárcalo para un
              backup ligero solo con la base de datos.
            </p>
          </div>
        </label>

        {downloadError && (
          <p className="text-[11px] text-red-400 flex items-center gap-1">
            <AlertCircle size={11} /> {downloadError}
          </p>
        )}
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
        >
          {downloading
            ? <><Loader size={14} className="animate-spin" /> Generando…</>
            : <><HardDriveDownload size={14} /> {includeImages ? 'Descargar backup completo' : 'Descargar backup (sin imágenes)'}</>}
        </button>
      </div>

      {/* Restore card */}
      <div
        className="rounded-xl border p-4 space-y-3"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
      >
        <div className="flex items-center gap-2">
          <HardDriveUpload size={15} className="text-amber-400 flex-shrink-0" />
          <span className="text-sm font-semibold text-text-primary">Restaurar backup</span>
        </div>

        {/* Warning banner */}
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2.5">
          <TriangleAlert size={13} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-300 leading-relaxed">
            <strong>Acción destructiva.</strong> Se reemplazará toda la carpeta{' '}
            <code className="bg-white/8 px-1 rounded">data/</code>, incluyendo la base de datos y las imágenes actuales.
            El servidor se reiniciará automáticamente tras la restauración.
            Haz un backup primero si tienes datos que quieres conservar.
          </p>
        </div>

        <p className="text-xs text-text-muted leading-relaxed">
          Selecciona un archivo <code className="bg-white/8 px-1 rounded text-[11px]">.tar.gz</code> generado
          previamente por esta aplicación.
        </p>

        {/* File selector */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setRestoreFile(f);
            setRestoreError(null);
            setConfirming(false);
            setRestoreDone(false);
            e.target.value = '';
          }}
        />

        {!restoreDone ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={restoring}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-border text-text-secondary hover:text-text-primary hover:bg-white/8 disabled:opacity-50 transition-colors"
              >
                <Upload size={12} />
                {restoreFile ? restoreFile.name : 'Seleccionar archivo…'}
              </button>
              {restoreFile && (
                <span className="text-[11px] text-text-muted">
                  {(restoreFile.size / 1024 / 1024).toFixed(1)} MB
                </span>
              )}
            </div>

            {restoreFile && !confirming && !restoring && (
              <button
                onClick={() => setConfirming(true)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-amber-500 text-white hover:bg-amber-600 transition-colors"
              >
                <HardDriveUpload size={14} />
                Restaurar este backup
              </button>
            )}

            {/* Confirmation step */}
            {confirming && !restoring && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/8 p-3 space-y-2">
                <p className="text-xs font-semibold text-red-400 flex items-center gap-1.5">
                  <TriangleAlert size={13} />
                  ¿Estás seguro? Esta acción no se puede deshacer.
                </p>
                <p className="text-[11px] text-red-300/80">
                  Se borrará toda la data actual y se reemplazará con el contenido del archivo{' '}
                  <strong>{restoreFile?.name}</strong>.
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={handleRestore}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500 text-white hover:bg-red-600 transition-colors"
                  >
                    <Check size={12} />
                    Sí, restaurar ahora
                  </button>
                  <button
                    onClick={() => setConfirming(false)}
                    className="px-3 py-1.5 rounded-lg text-xs text-text-muted hover:text-text-primary hover:bg-white/8 transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {restoring && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-text-muted">
                  <Loader size={14} className="animate-spin text-accent" />
                  {restoreProgress < 100
                    ? `Subiendo… ${restoreProgress}%`
                    : 'Restaurando datos… no cierres esta pestaña.'}
                </div>
                <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-300"
                    style={{ width: `${restoreProgress}%` }}
                  />
                </div>
              </div>
            )}

            {restoreError && (
              <p className="text-[11px] text-red-400 flex items-center gap-1">
                <AlertCircle size={11} /> {restoreError}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-emerald-400">
              <CheckCircle2 size={16} />
              {restoreMsg || 'Restauración completada.'}
            </div>
            {restoreNeedsRestart && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2.5">
                <TriangleAlert size={13} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-300 leading-relaxed">
                  Estás en Docker. Ve a <strong>Coolify → tu aplicación → Restart</strong> para que los datos restaurados sean efectivos.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
