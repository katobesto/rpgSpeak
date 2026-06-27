import { useState, useEffect, useRef, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import {
  X, Wand2, Loader, Image as ImageIcon, Trash2, Check, ImagePlus,
  SlidersHorizontal, EyeOff, Upload,
} from 'lucide-react';
import { generateApi, streamBackgroundImage } from '../../api/generate.ts';
import { settingsApi } from '../../api/settings.ts';
import { useChatStore } from '../../stores/chat.store.ts';
import { BACKGROUND_ASPECT_RATIOS } from '@rpgspeak/shared';
import type { BackgroundImage, ConversationBackground, BzWorkflow } from '@rpgspeak/shared';

interface BackgroundGeneratorModalProps {
  conversationId: string;
  onClose: () => void;
}

export function BackgroundGeneratorModal({ conversationId, onClose }: BackgroundGeneratorModalProps) {
  const activeConversation = useChatStore((s) => s.activeConversation);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);

  const gallery = ((activeConversation?.metadata?.backgroundGallery as BackgroundImage[] | undefined)) ?? [];
  const background = activeConversation?.metadata?.background as ConversationBackground | undefined;

  // ── Prompt state ──────────────────────────────────────────────────────────
  const [rawPrompt, setRawPrompt] = useState('');
  const [enhancedPrompt, setEnhancedPrompt] = useState('');
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);

  // ── Settings + workflows ─────────────────────────────────────────────────
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const isBzComfy = settings?.imageProvider === 'bzcomfy';
  const isComfyUi = settings?.imageProvider === 'comfyui';
  const showWorkflowSelector = isBzComfy || isComfyUi;

  const { data: workflows = [], isLoading: workflowsLoading } = useQuery<BzWorkflow[]>({
    queryKey: isBzComfy ? ['bzcomfy-workflows'] : ['comfyui-workflows'],
    queryFn: isBzComfy ? settingsApi.bzComfyWorkflows : settingsApi.comfyUiWorkflows,
    enabled: showWorkflowSelector,
    staleTime: 60_000,
  });

  const [selectedWorkflow, setSelectedWorkflow] = useState(settings?.bzComfyWorkflow ?? '');
  const selectedWorkflowObj = workflows.find((w) => w.id === selectedWorkflow) ?? null;
  const workflowHasLora = isBzComfy && !!selectedWorkflowObj?.hasLora;

  const { data: availableLoras = [] } = useQuery<string[]>({
    queryKey: ['bzcomfy-loras'],
    queryFn: settingsApi.bzComfyLoras,
    enabled: workflowHasLora,
    staleTime: 60_000,
  });

  const [selectedLora, setSelectedLora] = useState('');
  const [loraStrength, setLoraStrength] = useState(1.0);

  useEffect(() => {
    if (workflows.length === 0) return;
    const preferred = settings?.bzComfyWorkflow;
    const valid = workflows.find((w) => w.id === selectedWorkflow);
    if (!valid) {
      setSelectedWorkflow(preferred && workflows.find((w) => w.id === preferred) ? preferred! : workflows[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows]);

  // ── Aspect ratio ──────────────────────────────────────────────────────────
  const [aspectRatioId, setAspectRatioId] = useState(BACKGROUND_ASPECT_RATIOS[1].id); // 16:9 por defecto
  const aspectRatio = BACKGROUND_ASPECT_RATIOS.find((a) => a.id === aspectRatioId) ?? BACKGROUND_ASPECT_RATIOS[1];

  // ── Generation state ──────────────────────────────────────────────────────
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [currentNode, setCurrentNode] = useState('');
  const [stepValue, setStepValue] = useState(0);
  const [stepMax, setStepMax] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [latentPreviewUrl, setLatentPreviewUrl] = useState<string | null>(null);
  const sseCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => { return () => { sseCleanupRef.current?.(); }; }, []);

  // ── Gallery / active background actions ──────────────────────────────────
  const [galleryBusyId, setGalleryBusyId] = useState<string | null>(null);

  // ── Subida manual de fondos ───────────────────────────────────────────────
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite re-subir el mismo archivo
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const updated = await generateApi.uploadBackgroundImage(conversationId, file);
      setActiveConversation(updated);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Error al subir la imagen');
    } finally {
      setUploading(false);
    }
  }

  const finalPrompt = (enhancedPrompt || rawPrompt).trim();

  async function handleEnhance() {
    if (!rawPrompt.trim()) return;
    setEnhancing(true);
    setEnhanceError(null);
    try {
      const template = settings?.backgroundImagePrompt ?? '';
      const filled = template.replace('{{prompt}}', rawPrompt.trim());
      const data = await generateApi.runLlmPrompt(filled);
      setEnhancedPrompt(data.result);
    } catch (err) {
      setEnhanceError(err instanceof Error ? err.message : 'Error al llamar al LLM');
    } finally {
      setEnhancing(false);
    }
  }

  function handleGenerate() {
    if (!finalPrompt) return;
    setGenerating(true);
    setGenError(null);
    setCurrentNode('');
    setStepValue(0);
    setStepMax(0);
    setStatusMessage('Iniciando…');
    setLatentPreviewUrl(null);

    sseCleanupRef.current?.();
    sseCleanupRef.current = streamBackgroundImage(
      {
        conversationId,
        prompt: finalPrompt,
        workflowName: showWorkflowSelector ? (selectedWorkflow || undefined) : undefined,
        loraName: workflowHasLora ? (selectedLora || undefined) : undefined,
        loraStrength: workflowHasLora ? loraStrength : undefined,
        width: aspectRatio.width,
        height: aspectRatio.height,
      },
      (evt) => {
        if (evt.type === 'status') {
          setStatusMessage(evt.message);
        } else if (evt.type === 'node') {
          setCurrentNode(evt.nodeName);
          setStepValue(0);
          setStepMax(0);
          setStatusMessage('');
        } else if (evt.type === 'progress') {
          setStepValue(evt.value);
          setStepMax(evt.max);
        } else if (evt.type === 'latentPreview') {
          setLatentPreviewUrl(evt.dataUrl);
        } else if (evt.type === 'done') {
          setGenerating(false);
          setLatentPreviewUrl(null);
          if (activeConversation) {
            const meta = activeConversation.metadata ?? {};
            setActiveConversation({
              ...activeConversation,
              metadata: { ...meta, backgroundGallery: [...gallery, evt.image] },
            });
          }
        } else if (evt.type === 'error') {
          setGenError(evt.message);
          setGenerating(false);
        }
      },
    );
  }

  async function handleSetActive(img: BackgroundImage) {
    setGalleryBusyId(img.id);
    try {
      const updated = await generateApi.setActiveBackground(conversationId, {
        url: img.url,
        prompt: img.prompt,
        opacity: background?.opacity ?? 1,
      });
      setActiveConversation(updated);
    } finally {
      setGalleryBusyId(null);
    }
  }

  async function handleDelete(img: BackgroundImage) {
    setGalleryBusyId(img.id);
    try {
      const updated = await generateApi.deleteBackgroundImage(conversationId, img.id);
      setActiveConversation(updated);
    } finally {
      setGalleryBusyId(null);
    }
  }

  async function handleOpacityChange(opacity: number) {
    if (!background) return;
    const updated = await generateApi.setActiveBackground(conversationId, { ...background, opacity });
    setActiveConversation(updated);
  }

  async function handleClearBackground() {
    const updated = await generateApi.setActiveBackground(conversationId, null);
    setActiveConversation(updated);
  }

  const modal = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6"
      style={{ background: 'rgba(0,0,0,0.80)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative w-full max-w-2xl rounded-2xl border border-border flex flex-col animate-slide-up shadow-2xl"
        style={{ background: 'var(--surface-1)', maxHeight: 'min(92vh, 820px)', minHeight: '400px' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <ImagePlus size={15} className="text-accent" />
            <span className="font-semibold text-sm">Fondo de la conversación</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">

          {/* Prompt */}
          <section className="space-y-2">
            <p className="text-xs font-semibold text-text-secondary">Describe el escenario</p>
            <textarea
              value={rawPrompt}
              onChange={(e) => setRawPrompt(e.target.value)}
              rows={3}
              placeholder="Ej: un bosque oscuro con niebla al atardecer, ruinas élficas cubiertas de musgo…"
              className="w-full rounded-lg px-3 py-2.5 text-xs bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-y leading-relaxed"
            />
            <button
              onClick={handleEnhance}
              disabled={enhancing || !rawPrompt.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
            >
              {enhancing
                ? <><Loader size={12} className="animate-spin" /> Mejorando…</>
                : <><Wand2 size={12} /> Mejorar prompt</>}
            </button>
            {enhanceError && <p className="text-[11px] text-red-400">{enhanceError}</p>}
          </section>

          {/* Enhanced prompt */}
          <section className="space-y-2">
            <p className="text-xs font-semibold text-text-secondary">Prompt final (editable)</p>
            <textarea
              value={enhancedPrompt}
              onChange={(e) => setEnhancedPrompt(e.target.value)}
              rows={4}
              placeholder="Se usará este texto al generar. Si lo dejas vacío se usará la descripción de arriba tal cual."
              className="w-full rounded-lg px-3 py-2.5 text-xs bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono leading-relaxed"
            />
          </section>

          {/* Generation options */}
          <section className="space-y-3">
            <p className="text-xs font-semibold text-text-secondary">Opciones de generación</p>

            {showWorkflowSelector && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-text-muted">Workflow</p>
                {workflowsLoading ? (
                  <div className="flex items-center gap-2 text-xs text-text-muted py-1">
                    <Loader size={11} className="animate-spin" /> Cargando…
                  </div>
                ) : (
                  <select
                    value={selectedWorkflow}
                    onChange={(e) => setSelectedWorkflow(e.target.value)}
                    className="w-full border border-border rounded-lg px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    style={{ background: 'var(--surface-2)' }}
                  >
                    {workflows.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                    {workflows.length === 0 && <option value="">Sin workflows disponibles</option>}
                  </select>
                )}
              </div>
            )}

            {workflowHasLora && (
              <div className="space-y-2">
                <p className="text-[11px] text-text-muted">LoRA de estilo</p>
                <select
                  value={selectedLora}
                  onChange={(e) => setSelectedLora(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  style={{ background: 'var(--surface-2)' }}
                >
                  <option value="">Sin LoRA (predeterminado del workflow)</option>
                  {availableLoras.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
                {selectedLora && (
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] text-text-muted w-12 flex-shrink-0">Fuerza</span>
                    <input
                      type="range"
                      min={0} max={2} step={0.05}
                      value={loraStrength}
                      onChange={(e) => setLoraStrength(parseFloat(e.target.value))}
                      className="flex-1 accent-accent"
                    />
                    <span className="text-[11px] text-text-primary tabular-nums w-8 text-right">
                      {loraStrength.toFixed(2)}
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <p className="text-[11px] text-text-muted">Relación de aspecto</p>
              <div className="flex flex-wrap gap-1.5">
                {BACKGROUND_ASPECT_RATIOS.map((ar) => (
                  <button
                    key={ar.id}
                    onClick={() => setAspectRatioId(ar.id)}
                    className={`px-2.5 py-1.5 rounded-lg text-[11px] border transition-colors ${
                      aspectRatioId === ar.id
                        ? 'border-accent/50 bg-accent/10 text-accent'
                        : 'border-border text-text-muted hover:text-text-primary hover:border-border/80'
                    }`}
                  >
                    {ar.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Generate */}
          <section className="space-y-2">
            <button
              onClick={handleGenerate}
              disabled={generating || !finalPrompt}
              className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
            >
              {generating
                ? <><Loader size={12} className="animate-spin" /> Generando…</>
                : <><ImageIcon size={12} /> Generar</>}
            </button>

            {generating && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Loader size={12} className="animate-spin text-accent flex-shrink-0" />
                  <span className="text-sm font-medium text-text-primary truncate">
                    {currentNode || statusMessage || 'Iniciando…'}
                  </span>
                </div>
                {stepMax > 0 ? (
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-text-muted">
                      <span>paso {stepValue} de {stepMax}</span>
                      <span className="tabular-nums">{Math.round((stepValue / stepMax) * 100)}%</span>
                    </div>
                    <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-2)' }}>
                      <div
                        className="h-full rounded-full bg-accent transition-all duration-150"
                        style={{ width: `${Math.round((stepValue / stepMax) * 100)}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className="w-1.5 h-1.5 rounded-full bg-accent/60"
                        style={{ animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite` }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {genError && <p className="text-[11px] text-red-400">{genError}</p>}
          </section>

          {/* Active background controls */}
          {background && (
            <section className="space-y-2.5 border-t border-border pt-4">
              <p className="text-xs font-semibold text-text-secondary">Fondo activo</p>
              <div className="flex items-center gap-3">
                <SlidersHorizontal size={12} className="text-text-muted flex-shrink-0" />
                <input
                  type="range"
                  min={0} max={1} step={0.05}
                  value={background.opacity ?? 1}
                  onChange={(e) => handleOpacityChange(parseFloat(e.target.value))}
                  className="flex-1 accent-accent"
                />
                <span className="text-[11px] text-text-primary tabular-nums w-10 text-right">
                  {Math.round((background.opacity ?? 1) * 100)}%
                </span>
              </div>
              <button
                onClick={handleClearBackground}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors"
              >
                <EyeOff size={12} /> Quitar fondo
              </button>
            </section>
          )}

          {/* Gallery */}
          <section className="space-y-2 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-text-secondary">
                Galería de fondos{gallery.length > 0 ? ` (${gallery.length})` : ''}
              </p>
              <button
                onClick={() => uploadInputRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors disabled:opacity-50"
                title="Subir una imagen desde tu dispositivo"
              >
                {uploading
                  ? <><Loader size={12} className="animate-spin" /> Subiendo…</>
                  : <><Upload size={12} /> Subir fondo</>}
              </button>
              <input
                ref={uploadInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={handleUpload}
              />
            </div>
            {uploadError && <p className="text-[11px] text-red-400">{uploadError}</p>}
            {gallery.length === 0 ? (
              <p className="text-xs text-text-muted italic">Aún no hay fondos. Genera uno con IA o sube el tuyo.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {gallery.map((img) => {
                  const isActive = background?.url === img.url;
                  const busy = galleryBusyId === img.id;
                  return (
                    <div
                      key={img.id}
                      className={`group relative aspect-video rounded-xl overflow-hidden border transition-colors ${
                        isActive ? 'border-accent' : 'border-border'
                      }`}
                    >
                      <img src={img.url} alt={img.prompt} className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                        <button
                          onClick={() => handleSetActive(img)}
                          disabled={busy}
                          title="Usar como fondo"
                          className="p-2 rounded-lg bg-white/10 hover:bg-accent/80 text-white transition-colors disabled:opacity-50"
                        >
                          {busy ? <Loader size={14} className="animate-spin" /> : <Check size={14} />}
                        </button>
                        <button
                          onClick={() => handleDelete(img)}
                          disabled={busy}
                          title="Eliminar"
                          className="p-2 rounded-lg bg-white/10 hover:bg-red-500/80 text-white transition-colors disabled:opacity-50"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      {isActive && (
                        <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-accent text-white">
                          Activo
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Floating streaming preview – esquina inferior derecha */}
      {latentPreviewUrl && (
        <div
          className="absolute bottom-6 right-6 w-52 rounded-xl overflow-hidden shadow-2xl border border-white/10 z-10"
          style={{ background: 'var(--surface-1)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <img src={latentPreviewUrl} alt="Vista previa" className="w-full object-contain" />
          <div className="px-2.5 py-1.5 flex items-center gap-1.5 border-t border-white/8">
            {generating && <Loader size={10} className="animate-spin text-accent flex-shrink-0" />}
            <span className="text-[10px] text-text-muted truncate flex-1">
              {stepMax > 0
                ? `${currentNode || 'Paso'} ${stepValue}/${stepMax}`
                : (currentNode || statusMessage || 'Generando…')}
            </span>
            {stepMax > 0 && (
              <span className="text-[10px] text-text-muted tabular-nums">
                {Math.round((stepValue / stepMax) * 100)}%
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(modal, document.body);
}
