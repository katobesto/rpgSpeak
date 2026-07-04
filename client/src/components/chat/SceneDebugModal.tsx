import { useState, useEffect, useRef, useMemo } from 'react';
import { useBackHandler } from '../../hooks/useBackHandler.ts';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X, Loader, Wand2, Image as ImageIcon, ChevronRight, ChevronDown,
  User, UserPlus, AlertCircle, Minus, Plus, FlaskConical, Copy, Check,
} from 'lucide-react';
import { generateApi, streamSceneImage } from '../../api/generate.ts';
import { contextApi } from '../../api/context.ts';
import { settingsApi } from '../../api/settings.ts';
import { useAuthStore } from '../../stores/auth.store.ts';
import { useChatStore } from '../../stores/chat.store.ts';
import { Avatar } from '../ui/Avatar.tsx';
import type { Character, BzWorkflow } from '@rpgspeak/shared';

interface SceneDebugModalProps {
  conversationId: string;
  messageId: string;
  onDone: (imageUrl: string, sceneDescription: string, pending?: boolean) => void;
  onClose: () => void;
  initialWorkflow?: string;
}

type Step = 'context' | 'prompts' | 'generate';

const USER_SENTINEL = '__user__';
const CTX_PREFIX = 'ctx:';
const ctxId = (name: string) => `${CTX_PREFIX}${name.toLowerCase()}`;

interface SelectableEntity {
  id: string;
  name: string;
  avatar?: string | null;
  hasVisualDesc: boolean;
  isUser: boolean;
}

/** PNJ detectado en el contexto: no pertenece al roster de la conversación.
 *  Fuentes: índice de contexto (tipo 'character', con descripción) y líneas de
 *  diálogo `**Nombre:**` del narrador dentro del rango de mensajes elegido. */
interface ContextCharacter {
  name: string;
  description?: string;
  /** Tiene ficha en el índice de contexto (aporta descripción) */
  fromIndex: boolean;
  /** Habla o aparece en el rango de mensajes seleccionado */
  inScene: boolean;
}

export function SceneDebugModal({
  conversationId,
  messageId,
  onDone,
  onClose,
  initialWorkflow,
}: SceneDebugModalProps) {
  const qc = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const activeConversation = useChatStore((s) => s.activeConversation);
  const allMessages         = useChatStore((s) => s.messages);

  // Close on mobile swipe-back (component is only mounted while open)
  useBackHandler(true, onClose);

  // ── Entity list ───────────────────────────────────────────────────────────
  const entities: SelectableEntity[] = (() => {
    const allChars: Character[] = qc.getQueryData(['characters']) ?? [];
    const convCharIds = activeConversation?.characters.map((l) => l.characterId) ?? [];
    const convChars = allChars.filter((c) => convCharIds.includes(c.id));
    const list: SelectableEntity[] = convChars.map((c) => ({
      id: c.id, name: c.name, avatar: c.avatar,
      hasVisualDesc: Boolean(c.imageDescription?.trim()), isUser: false,
    }));
    if (currentUser?.appearance?.trim()) {
      list.push({
        id: USER_SENTINEL, name: `${currentUser.displayName} (tú)`,
        avatar: null, hasVisualDesc: true, isUser: true,
      });
    }
    return list;
  })();

  // ── Selection + message count ──────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(entities.map((e) => e.id))
  );
  const MIN_MSGS = 1;
  const MAX_MSGS = 20;
  const [messageCount, setMessageCount] = useState(6);

  const previewMessages = useMemo(() => {
    const clickedIdx = allMessages.findIndex((m) => m.id === messageId);
    return allMessages
      .slice(0, clickedIdx >= 0 ? clickedIdx + 1 : undefined)
      .filter((m) => m.role !== 'system')
      .slice(-messageCount);
  }, [allMessages, messageId, messageCount]);

  // ── Personajes del contexto (PNJs) ─────────────────────────────────────────
  // Detecta personajes que NO están en el roster pero aparecen en el contexto:
  //   1. Items del índice de contexto de tipo 'character' (traen descripción)
  //   2. Nombres de diálogo `**Nombre:**` en los mensajes del rango elegido
  const { data: contextItems = [] } = useQuery({
    queryKey: ['context', conversationId],
    queryFn: () => contextApi.list(conversationId),
    staleTime: 60_000,
  });

  const contextCharacters = useMemo<ContextCharacter[]>(() => {
    const allChars: Character[] = qc.getQueryData(['characters']) ?? [];
    const convCharIds = new Set(activeConversation?.characters.map((l) => l.characterId) ?? []);
    const known = new Set<string>(
      allChars.filter((c) => convCharIds.has(c.id)).map((c) => c.name.toLowerCase()),
    );
    if (currentUser?.displayName) known.add(currentUser.displayName.toLowerCase());

    const found = new Map<string, ContextCharacter>(); // key: nombre en minúsculas

    for (const item of contextItems) {
      if (item.type !== 'character') continue;
      const name = item.title.trim();
      if (!name || known.has(name.toLowerCase())) continue;
      if (!found.has(name.toLowerCase())) {
        found.set(name.toLowerCase(), {
          name,
          description: item.description?.trim() || undefined,
          fromIndex: true,
          inScene: false,
        });
      }
    }

    // Diálogo del narrador: líneas que empiezan con **Nombre:** (formato canónico).
    // Se excluyen candidatos con dígitos, demasiado largos, o que empiezan por un
    // rótulo común (falsos positivos tipo "**Nota:**" que no son nombres).
    const DIALOGUE_RE = /^\s*\*\*([^*\n]{1,40}?):\*\*/gm;
    const NOT_A_NAME_RE = /^(nota|importante|atención|atencion|aviso|advertencia|sistema|ubicación|ubicacion|resumen|recuerda|ooc|off)\b/i;
    for (const m of previewMessages) {
      if (m.role !== 'assistant') continue;
      for (const match of m.content.matchAll(DIALOGUE_RE)) {
        const name = match[1].trim();
        if (!name || /\d/.test(name) || name.split(/\s+/).length > 4 || NOT_A_NAME_RE.test(name)) continue;
        const key = name.toLowerCase();
        if (known.has(key)) continue;
        const existing = found.get(key);
        if (existing) {
          if (!existing.inScene) found.set(key, { ...existing, inScene: true });
        } else {
          found.set(key, { name, fromIndex: false, inScene: true });
        }
      }
    }

    return [...found.values()].sort((a, b) => Number(b.inScene) - Number(a.inScene));
  }, [contextItems, previewMessages, activeConversation, currentUser, qc]);

  // Auto-selección: los PNJs presentes en la escena actual entran marcados la
  // primera vez que se detectan; los que solo están en el índice, desmarcados.
  // offeredRef evita re-marcar un PNJ que el usuario ya desmarcó a mano cuando
  // cambia el rango de mensajes.
  const offeredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const toAdd: string[] = [];
    for (const c of contextCharacters) {
      const id = ctxId(c.name);
      if (!offeredRef.current.has(id)) {
        offeredRef.current.add(id);
        if (c.inScene) toAdd.push(id);
      }
    }
    if (toAdd.length) setSelected((prev) => new Set([...prev, ...toAdd]));
  }, [contextCharacters]);

  // ── Step ──────────────────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>('context');

  // ── Prompts step state ────────────────────────────────────────────────────
  const [llmPrompt,       setLlmPrompt]       = useState('');
  const [loadingPrompt,   setLoadingPrompt]   = useState(false);
  const [promptError,     setPromptError]     = useState<string | null>(null);
  const [imagePrompt,     setImagePrompt]     = useState('');
  const [runningLlm,      setRunningLlm]      = useState(false);
  const [llmError,        setLlmError]        = useState<string | null>(null);
  const [llmPromptOpen,   setLlmPromptOpen]   = useState(true);
  const [imagePromptOpen, setImagePromptOpen] = useState(true);
  const [promptCopied,    setPromptCopied]    = useState(false);

  // ── Generate step state ───────────────────────────────────────────────────
  const [generatingImage, setGeneratingImage] = useState(false);
  const [imageError,      setImageError]      = useState<string | null>(null);
  const [currentNode,     setCurrentNode]     = useState('');
  const [stepValue,       setStepValue]       = useState(0);
  const [stepMax,         setStepMax]         = useState(0);
  const [statusMessage,   setStatusMessage]   = useState('');
  const [latentPreviewUrl, setLatentPreviewUrl] = useState<string | null>(null);
  const [useFaceRef,      setUseFaceRef]      = useState(false);
  const [refCharId,       setRefCharId]       = useState<string>('');
  const [selectedLora,    setSelectedLora]    = useState<string>('');
  const [loraStrength,    setLoraStrength]    = useState(1.0);
  const [megapixel,       setMegapixel]       = useState<string>('');
  const [aspectRatio,     setAspectRatio]     = useState<string>('');
  const [baseModel,       setBaseModel]       = useState<string>('');
  const [powerLoraStates, setPowerLoraStates] = useState<Record<string, { name: string; on: boolean; strength: number }>>({});
  const sseCleanupRef = useRef<(() => void) | null>(null);

  // ── Settings + workflows ──────────────────────────────────────────────────
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const isBzComfy = settings?.imageProvider === 'bzcomfy';
  const { data: workflows = [], isLoading: workflowsLoading } = useQuery<BzWorkflow[]>({
    queryKey: isBzComfy ? ['bzcomfy-workflows'] : ['comfyui-workflows'],
    queryFn: isBzComfy ? settingsApi.bzComfyWorkflows : settingsApi.comfyUiWorkflows,
    enabled: settings != null,
    staleTime: 60_000,
  });

  const [selectedWorkflow, setSelectedWorkflow] = useState(
    initialWorkflow ?? settings?.bzComfyWorkflow ?? '',
  );

  const selectedWorkflowObj   = workflows.find((w) => w.id === selectedWorkflow) ?? null;
  const workflowHasLora       = isBzComfy && !!selectedWorkflowObj?.hasLora;
  const workflowHasResolution = !!selectedWorkflowObj?.hasResolutionControl;
  const workflowHasModelControl = !!selectedWorkflowObj?.hasModelControl;
  const workflowHasPowerLora    = !!selectedWorkflowObj?.hasPowerLora;

  const { data: availableLoras = [] } = useQuery<string[]>({
    queryKey: ['bzcomfy-loras'],
    queryFn: settingsApi.bzComfyLoras,
    enabled: workflowHasLora,
    staleTime: 60_000,
  });

  // Fetch the actual combo values from ComfyUI's object_info so they always
  // match the installed node version exactly (no hardcoded strings).
  const { data: resolutionOptions } = useQuery({
    queryKey: ['comfyui-resolution-options'],
    queryFn: settingsApi.comfyUiResolutionOptions,
    enabled: !isBzComfy && workflowHasResolution,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (workflows.length === 0) return;
    const preferred = settings?.bzComfyWorkflow;
    const valid = workflows.find((w) => w.id === selectedWorkflow);
    if (!valid) {
      setSelectedWorkflow(
        preferred && workflows.find((w) => w.id === preferred)
          ? preferred!
          : workflows[0].id,
      );
    }
  }, [workflows]);

  // Sync resolution defaults when selected workflow changes
  useEffect(() => {
    const wf = workflows.find((w) => w.id === selectedWorkflow);
    if (wf?.hasResolutionControl) {
      setMegapixel(wf.defaultMegapixel ?? '');
      setAspectRatio(wf.defaultAspectRatio ?? '');
    } else {
      setMegapixel('');
      setAspectRatio('');
    }
  }, [selectedWorkflow, workflows]);

  // Sync base-model + Power LoRA defaults when selected workflow changes
  useEffect(() => {
    const wf = workflows.find((w) => w.id === selectedWorkflow);
    setBaseModel(wf?.modelControl?.defaultModel ?? '');
    const loraMap: Record<string, { name: string; on: boolean; strength: number }> = {};
    for (const l of wf?.powerLoras ?? []) {
      loraMap[l.key] = { name: l.name, on: l.on, strength: l.strength };
    }
    setPowerLoraStates(loraMap);
  }, [selectedWorkflow, workflows]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectedCharacterIds() {
    return [...selected].filter((id) => id !== USER_SENTINEL && !id.startsWith(CTX_PREFIX));
  }
  function includeUser() { return selected.has(USER_SENTINEL); }
  function selectedExtraCharacters() {
    return contextCharacters
      .filter((c) => selected.has(ctxId(c.name)))
      .map((c) => ({ name: c.name, description: c.description }));
  }

  function copyPrompt() {
    if (!imagePrompt.trim()) return;
    navigator.clipboard.writeText(imagePrompt).then(() => {
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 1500);
    });
  }

  async function handleBuildPrompt() {
    setLoadingPrompt(true);
    setPromptError(null);
    setLlmPrompt('');
    setImagePrompt('');
    setLlmPromptOpen(true);
    setImagePromptOpen(true);
    try {
      const extras = selectedExtraCharacters();
      const data = await generateApi.buildScenePrompt(
        conversationId,
        messageId,
        selectedCharacterIds(),
        currentUser?.appearance?.trim() ? includeUser() : undefined,
        messageCount,
        extras.length > 0 ? extras : undefined,
      );
      setLlmPrompt(data.scenePrompt);
      setStep('prompts');
    } catch (err) {
      setPromptError(err instanceof Error ? err.message : 'Error al cargar el contexto');
    } finally {
      setLoadingPrompt(false);
    }
  }

  async function handleRunLlm() {
    if (!llmPrompt.trim()) return;
    setRunningLlm(true);
    setLlmError(null);
    setImagePromptOpen(true);
    try {
      const data = await generateApi.runLlmPrompt(llmPrompt.trim());
      setImagePrompt(data.result);
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : 'Error al llamar al LLM');
    } finally {
      setRunningLlm(false);
    }
  }

  function handleGoToGenerate() {
    setLatentPreviewUrl(null);
    setImageError(null);
    setGeneratingImage(false);
    setCurrentNode('');
    setStepValue(0);
    setStepMax(0);
    setStatusMessage('');
    setStep('generate');
  }

  function handleGenerateImage() {
    if (!imagePrompt.trim()) return;
    setGeneratingImage(true);
    setImageError(null);
    setCurrentNode('');
    setStepValue(0);
    setStepMax(0);
    setStatusMessage('Iniciando…');

    sseCleanupRef.current?.();
    sseCleanupRef.current = streamSceneImage(
      {
        conversationId,
        messageId,
        workflowName: selectedWorkflow,
        customPrompt: imagePrompt.trim(),
        useFaceReference: useFaceRef || undefined,
        referenceCharId: refCharId || undefined,
        loraName: workflowHasLora ? (selectedLora || undefined) : undefined,
        loraStrength: workflowHasLora ? loraStrength : undefined,
        megapixel: workflowHasResolution && megapixel ? megapixel : undefined,
        aspectRatio: workflowHasResolution && aspectRatio ? aspectRatio : undefined,
        baseModel: workflowHasModelControl && baseModel ? baseModel : undefined,
        powerLoraUpdates: workflowHasPowerLora
          ? Object.entries(powerLoraStates).map(([key, s]) => ({ key, on: s.on, strength: s.strength }))
          : undefined,
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
        } else if (evt.type === 'preview') {
          setCurrentNode('Mejorando a 4K…');
          setStepValue(0);
          setStepMax(0);
          setLatentPreviewUrl(evt.imageUrl);
          onDone(evt.imageUrl, evt.sceneDescription, true);
        } else if (evt.type === 'done') {
          setLatentPreviewUrl(evt.imageUrl);
          onDone(evt.imageUrl, evt.sceneDescription, false);
          setGeneratingImage(false);
          onClose();
        } else if (evt.type === 'error') {
          setImageError(evt.message);
          setGeneratingImage(false);
        }
      },
    );
  }

  useEffect(() => { return () => { sseCleanupRef.current?.(); }; }, []);

  useEffect(() => {
    setSelected(new Set(entities.map((e) => e.id)));
    const firstWithAvatar = entities.find((e) => !e.isUser && e.avatar);
    if (firstWithAvatar) setRefCharId(firstWithAvatar.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedCount = selected.size;
  const withVisualDesc = [...selected].filter((id) => {
    if (id.startsWith(CTX_PREFIX)) return contextCharacters.some((c) => ctxId(c.name) === id && c.description);
    return entities.find((x) => x.id === id)?.hasVisualDesc;
  }).length;

  // ── Modal ─────────────────────────────────────────────────────────────────
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
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <ImageIcon size={15} className="text-accent" />
            <span className="font-semibold text-sm">Generar imagen de escena</span>
            <div className="flex items-center gap-1 ml-2">
              <StepPill n={1} label="Contexto"  active={step === 'context'}  done={step !== 'context'} />
              <ChevronRight size={10} className="text-text-muted" />
              <StepPill n={2} label="Prompt"    active={step === 'prompts'}  done={step === 'generate'} />
              <ChevronRight size={10} className="text-text-muted" />
              <StepPill n={3} label="Generación" active={step === 'generate'} done={false} />
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* ── Scrollable body ─────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-5">

          {/* ══ STEP 1: Context & Characters ══════════════════════════════ */}
          {step === 'context' && (
            <div className="space-y-5">
              {/* Characters */}
              <section className="space-y-3">
                <SectionLabel n={1} text="Personajes en la escena" />
                <p className="text-[11px] text-text-muted">
                  Selecciona quién quieres que aparezca. Solo se incluirá la información visual de los marcados.
                </p>
                {entities.length === 0 ? (
                  <p className="text-xs text-text-muted italic">No hay personajes en esta conversación.</p>
                ) : (
                  <div className="space-y-1.5">
                    {entities.map((e) => {
                      const checked = selected.has(e.id);
                      return (
                        <button
                          key={e.id}
                          onClick={() => toggle(e.id)}
                          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all text-left ${
                            checked ? 'border-accent/50 bg-accent/8' : 'border-border bg-transparent hover:border-border/80 hover:bg-white/3'
                          }`}
                        >
                          <div className={`w-4 h-4 rounded flex-shrink-0 flex items-center justify-center border-2 transition-colors ${checked ? 'bg-accent border-accent' : 'border-border'}`}>
                            {checked && (
                              <svg viewBox="0 0 10 8" className="w-2.5 h-2.5 text-white fill-current">
                                <path d="M1 4l3 3 5-6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            )}
                          </div>
                          {e.isUser ? (
                            <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--accent)', opacity: 0.8 }}>
                              <User size={14} className="text-white" />
                            </div>
                          ) : (
                            <Avatar name={e.name} src={e.avatar} size="xs" />
                          )}
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-text-primary font-medium truncate block">{e.name}</span>
                          </div>
                          {e.hasVisualDesc ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20 flex-shrink-0">descripción visual ✓</span>
                          ) : (
                            <span className="flex items-center gap-1 text-[10px] text-yellow-500/80 flex-shrink-0">
                              <AlertCircle size={10} />sin apariencia
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* Personajes del contexto (PNJs) — no están en el grupo */}
                {contextCharacters.length > 0 && (
                  <>
                    <p className="text-[11px] text-text-muted pt-1">
                      Detectados en el contexto (no pertenecen al grupo). Los que traen descripción del
                      índice se describen con ella; el resto se describirá a partir de la propia escena.
                    </p>
                    <div className="space-y-1.5">
                      {contextCharacters.map((c) => {
                        const id = ctxId(c.name);
                        const checked = selected.has(id);
                        return (
                          <button
                            key={id}
                            onClick={() => toggle(id)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all text-left ${
                              checked ? 'border-accent/50 bg-accent/8' : 'border-border bg-transparent hover:border-border/80 hover:bg-white/3'
                            }`}
                          >
                            <div className={`w-4 h-4 rounded flex-shrink-0 flex items-center justify-center border-2 transition-colors ${checked ? 'bg-accent border-accent' : 'border-border'}`}>
                              {checked && (
                                <svg viewBox="0 0 10 8" className="w-2.5 h-2.5 text-white fill-current">
                                  <path d="M1 4l3 3 5-6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              )}
                            </div>
                            <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 border border-border" style={{ background: 'var(--surface-2)' }}>
                              <UserPlus size={13} className="text-text-muted" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <span className="text-sm text-text-primary font-medium truncate block">{c.name}</span>
                            </div>
                            {c.inScene && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20 flex-shrink-0">en escena</span>
                            )}
                            {c.fromIndex && c.description ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20 flex-shrink-0">descripción del índice ✓</span>
                            ) : (
                              <span className="text-[10px] text-yellow-500/80 flex-shrink-0">apariencia inferida</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
                <p className="text-[11px] text-text-muted">
                  {selectedCount === 0
                    ? 'Ningún personaje seleccionado.'
                    : `${selectedCount} seleccionado${selectedCount !== 1 ? 's' : ''} · ${withVisualDesc} con descripción visual`}
                </p>
                {promptError && <p className="text-[11px] text-red-400">{promptError}</p>}
              </section>

              {/* Message count */}
              <div className="border-t border-border" />
              <section className="space-y-3">
                <SectionLabel n={2} text="Contexto de mensajes" />
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-text-muted">Cuántos mensajes recientes se usarán como contexto.</p>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setMessageCount((n) => Math.max(MIN_MSGS, n - 1))}
                      disabled={messageCount <= MIN_MSGS}
                      className="w-7 h-7 flex items-center justify-center rounded-lg border border-border hover:bg-white/8 text-text-muted hover:text-text-primary disabled:opacity-30 transition-colors"
                    ><Minus size={12} /></button>
                    <span className="w-8 text-center text-sm font-bold text-text-primary tabular-nums">{messageCount}</span>
                    <button
                      onClick={() => setMessageCount((n) => Math.min(MAX_MSGS, n + 1))}
                      disabled={messageCount >= MAX_MSGS}
                      className="w-7 h-7 flex items-center justify-center rounded-lg border border-border hover:bg-white/8 text-text-muted hover:text-text-primary disabled:opacity-30 transition-colors"
                    ><Plus size={12} /></button>
                  </div>
                </div>
                {/* Message preview */}
                <div className="rounded-xl border border-border overflow-hidden" style={{ background: 'var(--surface-2)' }}>
                  <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Vista previa del contexto</span>
                    <span className="text-[10px] text-text-muted">{previewMessages.length} mensaje{previewMessages.length !== 1 ? 's' : ''}</span>
                  </div>
                  {previewMessages.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-text-muted italic">No hay mensajes disponibles.</p>
                  ) : (
                    <div className="max-h-36 overflow-y-auto divide-y divide-border/50">
                      {previewMessages.map((m) => (
                        <div key={m.id} className="px-3 py-2 flex items-start gap-2">
                          <span className={`flex-shrink-0 text-[9px] font-bold uppercase tracking-wider mt-0.5 w-14 text-right ${
                            m.role === 'user' ? 'text-accent' : m.role === 'assistant' ? 'text-text-secondary' : 'text-text-muted'
                          }`}>
                            {m.role === 'user' ? 'Usuario' : m.role === 'assistant' ? 'PJ' : m.role}
                          </span>
                          <p className="text-[11px] text-text-primary leading-relaxed line-clamp-2 flex-1">{m.content}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}

          {/* ══ STEP 2: Prompts ═══════════════════════════════════════════ */}
          {step === 'prompts' && (
            <div className="space-y-4">
              {/* Accordion 1: LLM context */}
              <AccordionSection
                title="Contexto enviado al LLM"
                open={llmPromptOpen}
                onToggle={() => setLlmPromptOpen((v) => !v)}
              >
                {loadingPrompt ? (
                  <div className="flex items-center gap-2 py-6 text-text-muted text-xs justify-center">
                    <Loader size={13} className="animate-spin" /> Cargando contexto…
                  </div>
                ) : (
                  <textarea
                    value={llmPrompt}
                    onChange={(e) => setLlmPrompt(e.target.value)}
                    rows={9}
                    className="w-full text-xs bg-transparent border border-border rounded-lg px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono leading-relaxed"
                  />
                )}
                {promptError && <p className="text-[11px] text-red-400 mt-1">{promptError}</p>}
              </AccordionSection>

              {/* Generate image prompt button */}
              <button
                onClick={handleRunLlm}
                disabled={runningLlm || !llmPrompt.trim() || loadingPrompt}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
              >
                {runningLlm
                  ? <><Loader size={12} className="animate-spin" /> Generando prompt…</>
                  : <><Wand2 size={12} /> Generar prompt de imagen</>}
              </button>

              {/* Accordion 2: Image prompt (appears once running or available) */}
              {(imagePrompt || runningLlm) && (
                <AccordionSection
                  title="Prompt de imagen resultante"
                  open={imagePromptOpen}
                  onToggle={() => setImagePromptOpen((v) => !v)}
                  action={imagePrompt.trim()
                    ? (
                      <button
                        onClick={copyPrompt}
                        className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary transition-colors"
                      >
                        {promptCopied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                        {promptCopied ? 'Copiado' : 'Copiar'}
                      </button>
                    )
                    : undefined}
                >
                  {runningLlm && !imagePrompt ? (
                    <div className="flex items-center gap-2 py-6 text-text-muted text-xs justify-center">
                      <Loader size={13} className="animate-spin" /> El LLM está describiendo la escena…
                    </div>
                  ) : (
                    <textarea
                      value={imagePrompt}
                      onChange={(e) => setImagePrompt(e.target.value)}
                      rows={5}
                      className="w-full text-xs bg-transparent border border-border rounded-lg px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono leading-relaxed"
                    />
                  )}
                  {llmError && <p className="text-[11px] text-red-400 mt-1">{llmError}</p>}
                </AccordionSection>
              )}
            </div>
          )}

          {/* ══ STEP 3: Generation ════════════════════════════════════════ */}
          {step === 'generate' && (
            <div className="space-y-4">
              {/* Workflow selector */}
              <section className="space-y-1.5">
                <p className="text-xs font-semibold text-text-secondary">Workflow</p>
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
              </section>

              {/* Base model selector (only when workflow exposes a modelControl) */}
              {workflowHasModelControl && (
                <section className="space-y-1.5">
                  <p className="text-xs font-semibold text-text-secondary">
                    {selectedWorkflowObj?.modelControl?.label || 'Modelo base'}
                  </p>
                  <select
                    value={baseModel}
                    onChange={(e) => setBaseModel(e.target.value)}
                    className="w-full border border-border rounded-lg px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    style={{ background: 'var(--surface-2)' }}
                  >
                    {(selectedWorkflowObj?.modelControl?.options ?? []).map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                    {(selectedWorkflowObj?.modelControl?.options ?? []).length === 0 && (
                      <option value="">Sin modelos disponibles</option>
                    )}
                  </select>
                </section>
              )}

              {/* Power LoRA controls (only when workflow has a Power Lora Loader node) */}
              {workflowHasPowerLora && (
                <section className="space-y-2.5">
                  <p className="text-xs font-semibold text-text-secondary">LoRAs</p>
                  <div className="space-y-2">
                    {Object.entries(powerLoraStates).map(([key, lora]) => (
                      <div key={key} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2">
                        <button
                          onClick={() => setPowerLoraStates((prev) => ({
                            ...prev,
                            [key]: { ...prev[key], on: !prev[key].on },
                          }))}
                          className={`w-7 h-4 rounded-full transition-colors relative flex-shrink-0 ${lora.on ? 'bg-accent' : 'bg-white/10'}`}
                        >
                          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${lora.on ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                        </button>
                        <span className="text-[11px] text-text-primary truncate flex-1" title={lora.name}>
                          {lora.name || key}
                        </span>
                        <input
                          type="range"
                          min={0} max={2} step={0.05}
                          value={lora.strength}
                          disabled={!lora.on}
                          onChange={(e) => setPowerLoraStates((prev) => ({
                            ...prev,
                            [key]: { ...prev[key], strength: parseFloat(e.target.value) },
                          }))}
                          className="flex-1 accent-accent disabled:opacity-40"
                        />
                        <span className="text-[11px] text-text-primary tabular-nums w-8 text-right flex-shrink-0">
                          {lora.strength.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* LoRA selector (only when workflow supports it) */}
              {workflowHasLora && (
                <section className="space-y-2">
                  <p className="text-xs font-semibold text-text-secondary">LoRA de estilo</p>
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
                </section>
              )}

              {/* Resolution control (FluxResolutionNode workflows) */}
              {workflowHasResolution && (
                <section className="space-y-2.5">
                  <p className="text-xs font-semibold text-text-secondary">Resolución base</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[10px] text-text-muted">Megapíxeles</label>
                      <select
                        value={megapixel}
                        onChange={(e) => setMegapixel(e.target.value)}
                        className="w-full border border-border rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                        style={{ background: 'var(--surface-2)' }}
                      >
                        {(resolutionOptions?.megapixels ?? []).map((v) => (
                          <option key={v} value={v}>{v} MP</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-text-muted">Proporción</label>
                      <select
                        value={aspectRatio}
                        onChange={(e) => setAspectRatio(e.target.value)}
                        className="w-full border border-border rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                        style={{ background: 'var(--surface-2)' }}
                      >
                        {(resolutionOptions?.aspectRatios ?? []).map((v) => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {megapixel && aspectRatio && (
                    <p className="text-[10px] text-text-muted">
                      {megapixel} MP · {aspectRatio.split(' ')[0]}
                    </p>
                  )}
                </section>
              )}

              {/* BETA FaceID */}
              <section>
                <div className="flex items-center gap-2 border border-border rounded-xl px-3 py-2.5 w-fit">
                  <FlaskConical size={11} className={useFaceRef ? 'text-amber-400' : 'text-text-muted'} />
                  <span className="text-[10px] text-text-muted font-medium">BETA FaceID</span>
                  <button
                    onClick={() => setUseFaceRef((v) => !v)}
                    title="Usar imagen del personaje como referencia facial (requiere SDXL + FaceID)"
                    className={`w-7 h-4 rounded-full transition-colors relative ${useFaceRef ? 'bg-amber-500' : 'bg-white/10'}`}
                  >
                    <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${useFaceRef ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                  </button>
                  {useFaceRef && (
                    <select
                      value={refCharId}
                      onChange={(e) => setRefCharId(e.target.value)}
                      className="ml-1 text-[10px] bg-transparent border-none text-text-primary outline-none cursor-pointer max-w-[110px] truncate"
                    >
                      {entities.filter((e) => !e.isUser && e.avatar).map((e) => (
                        <option key={e.id} value={e.id}>{e.name}</option>
                      ))}
                    </select>
                  )}
                </div>
              </section>

              {/* Progress */}
              {generatingImage && (
                <section className="space-y-2">
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
                </section>
              )}

              {imageError && <p className="text-[11px] text-red-400">{imageError}</p>}
            </div>
          )}
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t border-border flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs text-text-muted hover:text-text-primary hover:bg-white/8 transition-colors"
          >
            Cancelar
          </button>

          <div className="flex items-center gap-2">
            {/* Step 1 footer */}
            {step === 'context' && (
              <button
                onClick={handleBuildPrompt}
                disabled={loadingPrompt || selectedCount === 0}
                className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
              >
                {loadingPrompt
                  ? <><Loader size={12} className="animate-spin" /> Cargando…</>
                  : <>Continuar <ChevronRight size={12} /></>}
              </button>
            )}

            {/* Step 2 footer */}
            {step === 'prompts' && (
              <>
                <button
                  onClick={() => setStep('context')}
                  className="px-3 py-2 rounded-lg text-xs text-text-muted hover:text-text-primary hover:bg-white/8 border border-border transition-colors"
                >
                  ← Contexto
                </button>
                <button
                  onClick={handleGoToGenerate}
                  disabled={!imagePrompt.trim() || runningLlm}
                  className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
                >
                  Continuar <ChevronRight size={12} />
                </button>
              </>
            )}

            {/* Step 3 footer */}
            {step === 'generate' && (
              <>
                <button
                  onClick={() => setStep('prompts')}
                  disabled={generatingImage}
                  className="px-3 py-2 rounded-lg text-xs text-text-muted hover:text-text-primary hover:bg-white/8 border border-border transition-colors disabled:opacity-40"
                >
                  ← Prompt
                </button>
                <button
                  onClick={handleGenerateImage}
                  disabled={!imagePrompt.trim() || generatingImage || (useFaceRef && !refCharId)}
                  className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
                >
                  {generatingImage
                    ? <><Loader size={12} className="animate-spin" /> Generando…</>
                    : useFaceRef
                      ? <><FlaskConical size={12} /> Generar (BETA)</>
                      : <><ImageIcon size={12} /> Generar imagen</>}
                </button>
              </>
            )}
          </div>
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
            {generatingImage && <Loader size={10} className="animate-spin text-accent flex-shrink-0" />}
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

// ── Small helpers ─────────────────────────────────────────────────────────────

function StepPill({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <span className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
      done  ? 'border-green-500/40 bg-green-500/10 text-green-400'
            : active ? 'border-accent/40 bg-accent/10 text-accent'
            : 'border-border text-text-muted'
    }`}>
      <span className="font-bold">{n}</span>
      {label}
    </span>
  );
}

function SectionLabel({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center justify-center w-4 h-4 rounded-full bg-accent/20 text-accent text-[10px] font-bold flex-shrink-0">
        {n}
      </span>
      <span className="text-xs font-semibold text-text-primary">{text}</span>
    </div>
  );
}

function AccordionSection({
  title, open, onToggle, children, action,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/3 transition-colors"
        style={{ background: 'var(--surface-2)' }}
      >
        <span className="text-xs font-semibold text-text-primary">{title}</span>
        <div className="flex items-center gap-2">
          {action && <div onClick={(e) => e.stopPropagation()}>{action}</div>}
          <ChevronDown size={13} className={`text-text-muted transition-transform duration-200 ${open ? '' : '-rotate-90'}`} />
        </div>
      </button>
      {open && (
        <div className="px-4 pt-3 pb-4 space-y-2">
          {children}
        </div>
      )}
    </div>
  );
}
