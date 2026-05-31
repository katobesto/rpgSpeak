import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { X, Loader, Wand2, Image as ImageIcon, ChevronRight, User, AlertCircle, Minus, Plus, FlaskConical } from 'lucide-react';
import { generateApi } from '../../api/generate.ts';
import { useAuthStore } from '../../stores/auth.store.ts';
import { useChatStore } from '../../stores/chat.store.ts';
import { Avatar } from '../ui/Avatar.tsx';
import type { Character } from '@rpgspeak/shared';

interface SceneDebugModalProps {
  conversationId: string;
  messageId: string;
  onGenerate: (imagePrompt: string, opts?: { useFaceReference?: boolean; referenceCharId?: string }) => Promise<void>;
  onClose: () => void;
}

type Step = 'characters' | 'prompt' | 'result';

// ── Special sentinel ID for the current user ──────────────────────────────────
const USER_SENTINEL = '__user__';

interface SelectableEntity {
  id: string;          // character ID or USER_SENTINEL
  name: string;
  avatar?: string | null;
  hasVisualDesc: boolean;  // has imageDescription (chars) or appearance (user)
  isUser: boolean;
}

export function SceneDebugModal({
  conversationId,
  messageId,
  onGenerate,
  onClose,
}: SceneDebugModalProps) {
  const qc = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const activeConversation = useChatStore((s) => s.activeConversation);
  const allMessages         = useChatStore((s) => s.messages);

  // ── Build the selectable entity list ─────────────────────────────────────
  const entities: SelectableEntity[] = (() => {
    const allChars: Character[] = qc.getQueryData(['characters']) ?? [];
    const convCharIds = activeConversation?.characters.map((l) => l.characterId) ?? [];
    const convChars = allChars.filter((c) => convCharIds.includes(c.id));

    const list: SelectableEntity[] = convChars.map((c) => ({
      id:           c.id,
      name:         c.name,
      avatar:       c.avatar,
      hasVisualDesc: Boolean(c.imageDescription?.trim()),
      isUser:       false,
    }));

    // Add user entry if they have an appearance description
    if (currentUser?.appearance?.trim()) {
      list.push({
        id:           USER_SENTINEL,
        name:         `${currentUser.displayName} (tú)`,
        avatar:       null,
        hasVisualDesc: true,
        isUser:       true,
      });
    }

    return list;
  })();

  // ── Selection state: all selected by default ──────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(entities.map((e) => e.id))
  );

  // ── Message count ─────────────────────────────────────────────────────────
  const MIN_MSGS = 1;
  const MAX_MSGS = 20;
  const [messageCount, setMessageCount] = useState(6);

  /** Live preview: messages that will actually be sent as context */
  const previewMessages = useMemo(() => {
    const clickedIdx = allMessages.findIndex((m) => m.id === messageId);
    return allMessages
      .slice(0, clickedIdx >= 0 ? clickedIdx + 1 : undefined)
      .filter((m) => m.role !== 'system')
      .slice(-messageCount);
  }, [allMessages, messageId, messageCount]);

  // ── Step tracking ─────────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>('characters');

  // ── Step 2: LLM input prompt ──────────────────────────────────────────────
  const [llmPrompt,     setLlmPrompt]     = useState('');
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [promptError,   setPromptError]   = useState<string | null>(null);

  // ── Step 3: LLM output (image prompt) ────────────────────────────────────
  const [imagePrompt,   setImagePrompt]   = useState('');
  const [runningLlm,    setRunningLlm]    = useState(false);
  const [llmError,      setLlmError]      = useState<string | null>(null);

  // ── Step 4: ComfyUI generation ────────────────────────────────────────────
  const [generatingImage, setGeneratingImage] = useState(false);
  const [imageError,      setImageError]      = useState<string | null>(null);

  // ── BETA: FaceID reference ────────────────────────────────────────────────
  const [useFaceRef,      setUseFaceRef]      = useState(false);
  const [refCharId,       setRefCharId]       = useState<string>('');

  // ── Helpers ───────────────────────────────────────────────────────────────
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectedCharacterIds(): string[] {
    return [...selected].filter((id) => id !== USER_SENTINEL);
  }

  function includeUser(): boolean {
    return selected.has(USER_SENTINEL);
  }

  async function handleBuildPrompt() {
    setLoadingPrompt(true);
    setPromptError(null);
    setLlmPrompt('');
    setImagePrompt('');
    try {
      const data = await generateApi.buildScenePrompt(
        conversationId,
        messageId,
        selectedCharacterIds(),
        currentUser?.appearance?.trim() ? includeUser() : undefined,
        messageCount,
      );
      setLlmPrompt(data.scenePrompt);
      setStep('prompt');
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
    try {
      const data = await generateApi.runLlmPrompt(llmPrompt.trim());
      setImagePrompt(data.result);
      setStep('result');
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : 'Error al llamar al LLM');
    } finally {
      setRunningLlm(false);
    }
  }

  async function handleGenerateImage() {
    if (!imagePrompt.trim()) return;
    setGeneratingImage(true);
    setImageError(null);
    try {
      await onGenerate(imagePrompt.trim(), useFaceRef ? {
        useFaceReference: true,
        referenceCharId: refCharId || undefined,
      } : undefined);
      onClose();
    } catch (err) {
      setImageError(err instanceof Error ? err.message : 'Error al generar la imagen');
      setGeneratingImage(false);
    }
  }

  // Pre-select all when entity list changes (e.g. after mount)
  useEffect(() => {
    setSelected(new Set(entities.map((e) => e.id)));
    // Default reference character = first non-user entity with an avatar
    const firstWithAvatar = entities.find((e) => !e.isUser && e.avatar);
    if (firstWithAvatar) setRefCharId(firstWithAvatar.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedCount = selected.size;
  const withVisualDesc = [...selected].filter((id) => {
    const e = entities.find((x) => x.id === id);
    return e?.hasVisualDesc;
  }).length;

  const modal = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6"
      style={{ background: 'rgba(0,0,0,0.80)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative w-full max-w-3xl rounded-2xl border border-border flex flex-col animate-slide-up shadow-2xl"
        style={{
          background: 'var(--surface-1)',
          maxHeight: 'min(92vh, 860px)',
          minHeight: '420px',
        }}
      >
        {/* ── Header ───────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <ImageIcon size={15} className="text-accent" />
            <span className="font-semibold text-sm">Generar imagen de escena</span>
            {/* Step pills */}
            <div className="flex items-center gap-1 ml-2">
              <StepPill n={1} label="Personajes" active={step === 'characters'} done={step === 'prompt' || step === 'result'} />
              <ChevronRight size={10} className="text-text-muted" />
              <StepPill n={2} label="Contexto" active={step === 'prompt'} done={step === 'result'} />
              <ChevronRight size={10} className="text-text-muted" />
              <StepPill n={3} label="Prompt imagen" active={step === 'result'} done={false} />
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* ── Scrollable body ───────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">

          {/* ════════════════════════════════════════════════════════════════
              STEP 1 — Character selection
          ════════════════════════════════════════════════════════════════ */}
          <section className="space-y-3">
            <SectionLabel n={1} text="Personajes en la escena" />
            <p className="text-[11px] text-text-muted">
              Selecciona quién quieres que aparezca en la imagen. Solo se incluirá en el prompt
              la información visual de los marcados.
            </p>

            {entities.length === 0 ? (
              <p className="text-xs text-text-muted italic">
                No hay personajes en esta conversación.
              </p>
            ) : (
              <div className="space-y-1.5">
                {entities.map((e) => {
                  const checked = selected.has(e.id);
                  return (
                    <button
                      key={e.id}
                      onClick={() => toggle(e.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all text-left ${
                        checked
                          ? 'border-accent/50 bg-accent/8'
                          : 'border-border bg-transparent hover:border-border/80 hover:bg-white/3'
                      }`}
                    >
                      {/* Checkbox */}
                      <div className={`w-4 h-4 rounded flex-shrink-0 flex items-center justify-center border-2 transition-colors ${
                        checked ? 'bg-accent border-accent' : 'border-border'
                      }`}>
                        {checked && (
                          <svg viewBox="0 0 10 8" className="w-2.5 h-2.5 text-white fill-current">
                            <path d="M1 4l3 3 5-6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>

                      {/* Avatar */}
                      {e.isUser ? (
                        <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                             style={{ background: 'var(--accent)', opacity: 0.8 }}>
                          <User size={14} className="text-white" />
                        </div>
                      ) : (
                        <Avatar name={e.name} src={e.avatar} size="xs" />
                      )}

                      {/* Name + badge */}
                      <div className="flex-1 min-w-0">
                        <span className="text-sm text-text-primary font-medium truncate block">
                          {e.name}
                        </span>
                      </div>

                      {/* Visual desc indicator */}
                      {e.hasVisualDesc ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20 flex-shrink-0">
                          descripción visual ✓
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[10px] text-yellow-500/80 flex-shrink-0" title="Sin descripción de apariencia — aparecerá en el prompt pero puede no reflejarse en la imagen">
                          <AlertCircle size={10} />
                          sin apariencia
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Summary line */}
            <p className="text-[11px] text-text-muted">
              {selectedCount === 0
                ? 'Ningún personaje seleccionado.'
                : `${selectedCount} seleccionado${selectedCount !== 1 ? 's' : ''} · ${withVisualDesc} con descripción visual`}
            </p>

            {promptError && <p className="text-[11px] text-red-400">{promptError}</p>}
          </section>

          {/* ════════════════════════════════════════════════════════════════
              MESSAGE COUNT + LIVE PREVIEW (always shown in step 1)
          ════════════════════════════════════════════════════════════════ */}
          <div className="border-t border-border" />
          <section className="space-y-3">
            {/* Counter row */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-text-primary">Mensajes de contexto</p>
                <p className="text-[11px] text-text-muted mt-0.5">
                  Cuántos mensajes recientes se incluirán al generar el contexto.
                  {step !== 'characters' && (
                    <span className="text-yellow-500 ml-1">Cambiarlo reinicia el contexto.</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setMessageCount((n) => Math.max(MIN_MSGS, n - 1));
                    // Invalidate any already-built context so the user has to rebuild
                    if (step !== 'characters') { setStep('characters'); setLlmPrompt(''); setImagePrompt(''); }
                  }}
                  disabled={messageCount <= MIN_MSGS}
                  className="w-7 h-7 flex items-center justify-center rounded-lg border border-border hover:bg-white/8 text-text-muted hover:text-text-primary disabled:opacity-30 transition-colors"
                >
                  <Minus size={12} />
                </button>
                <span className="w-8 text-center text-sm font-bold text-text-primary tabular-nums">
                  {messageCount}
                </span>
                <button
                  onClick={() => {
                    setMessageCount((n) => Math.min(MAX_MSGS, n + 1));
                    if (step !== 'characters') { setStep('characters'); setLlmPrompt(''); setImagePrompt(''); }
                  }}
                  disabled={messageCount >= MAX_MSGS}
                  className="w-7 h-7 flex items-center justify-center rounded-lg border border-border hover:bg-white/8 text-text-muted hover:text-text-primary disabled:opacity-30 transition-colors"
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>

            {/* Live message preview */}
            <div
              className="rounded-xl border border-border overflow-hidden"
              style={{ background: 'var(--surface-2)' }}
            >
              <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                  Vista previa del contexto
                </span>
                <span className="text-[10px] text-text-muted">
                  {previewMessages.length} mensaje{previewMessages.length !== 1 ? 's' : ''}
                </span>
              </div>
              {previewMessages.length === 0 ? (
                <p className="px-3 py-3 text-xs text-text-muted italic">
                  No hay mensajes disponibles.
                </p>
              ) : (
                <div className="max-h-48 overflow-y-auto divide-y divide-border/50">
                  {previewMessages.map((m) => {
                    const isUser  = m.role === 'user';
                    const isAssistant = m.role === 'assistant';
                    return (
                      <div key={m.id} className="px-3 py-2 flex items-start gap-2">
                        <span className={`flex-shrink-0 text-[9px] font-bold uppercase tracking-wider mt-0.5 w-14 text-right ${
                          isUser ? 'text-accent' : isAssistant ? 'text-text-secondary' : 'text-text-muted'
                        }`}>
                          {isUser ? 'Usuario' : isAssistant ? 'PJ' : m.role}
                        </span>
                        <p className="text-[11px] text-text-primary leading-relaxed line-clamp-2 flex-1">
                          {m.content}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          {/* ════════════════════════════════════════════════════════════════
              STEP 2 — LLM prompt (shown after clicking "Continuar")
          ════════════════════════════════════════════════════════════════ */}
          {(step === 'prompt' || step === 'result') && (
            <>
              <div className="border-t border-border" />
              <section className="space-y-2">
                <SectionLabel n={2} text="Contexto enviado al LLM" />
                <p className="text-[11px] text-text-muted">
                  Prompt que describe la escena a la IA. Puedes editarlo antes de generar.
                </p>
                <textarea
                  value={llmPrompt}
                  onChange={(e) => setLlmPrompt(e.target.value)}
                  rows={10}
                  className="w-full text-xs bg-transparent border border-border rounded-lg px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono leading-relaxed"
                />
                {llmError && <p className="text-[11px] text-red-400">{llmError}</p>}
                <button
                  onClick={handleRunLlm}
                  disabled={runningLlm || !llmPrompt.trim()}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
                >
                  {runningLlm
                    ? <><Loader size={12} className="animate-spin" /> Generando prompt…</>
                    : <><Wand2 size={12} /> Generar prompt de imagen</>}
                </button>
              </section>
            </>
          )}

          {/* ════════════════════════════════════════════════════════════════
              STEP 3 — Image prompt result
          ════════════════════════════════════════════════════════════════ */}
          {(step === 'result' || (runningLlm && step === 'prompt')) && (
            <>
              <div className="border-t border-border" />
              <section className="space-y-2">
                <SectionLabel n={3} text="Prompt de imagen resultante" />
                <p className="text-[11px] text-text-muted">
                  Prompt que se enviará a ComfyUI. Puedes editarlo antes de generar.
                </p>
                {runningLlm && !imagePrompt ? (
                  <div className="flex items-center gap-2 py-4 text-text-muted text-xs">
                    <Loader size={13} className="animate-spin" />
                    El LLM está describiendo la escena…
                  </div>
                ) : (
                  <textarea
                    value={imagePrompt}
                    onChange={(e) => setImagePrompt(e.target.value)}
                    rows={6}
                    className="w-full text-xs bg-transparent border border-border rounded-lg px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono leading-relaxed"
                  />
                )}
                {imageError && <p className="text-[11px] text-red-400">{imageError}</p>}
              </section>
            </>
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 border-t border-border flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs text-text-muted hover:text-text-primary hover:bg-white/8 transition-colors"
          >
            Cancelar
          </button>

          <div className="flex flex-wrap items-center gap-2">
            {/* Step 1 → 2 */}
            {step === 'characters' && (
              <button
                onClick={handleBuildPrompt}
                disabled={loadingPrompt || selectedCount === 0}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
              >
                {loadingPrompt
                  ? <><Loader size={12} className="animate-spin" /> Cargando…</>
                  : <>Continuar <ChevronRight size={12} /></>}
              </button>
            )}

            {/* Step 2: re-fetch prompt with new selection */}
            {(step === 'prompt' || step === 'result') && (
              <button
                onClick={() => { setStep('characters'); setImagePrompt(''); }}
                className="px-3 py-2 rounded-lg text-xs text-text-muted hover:text-text-primary hover:bg-white/8 border border-border transition-colors"
              >
                ← Personajes
              </button>
            )}

            {/* Step 3: BETA toggle + generate image */}
            {step === 'result' && (
              <div className="flex flex-wrap items-center gap-2">
                {/* BETA: FaceID reference toggle */}
                <div className="flex items-center gap-1.5 border border-border rounded-lg px-2.5 py-1.5">
                  <FlaskConical size={11} className={useFaceRef ? 'text-amber-400' : 'text-text-muted'} />
                  <span className="text-[10px] text-text-muted font-medium">BETA</span>
                  <button
                    onClick={() => setUseFaceRef((v) => !v)}
                    title="Usar imagen del personaje como referencia facial (requiere SDXL + FaceID)"
                    className={`w-7 h-4 rounded-full transition-colors relative flex-shrink-0 ${useFaceRef ? 'bg-amber-500' : 'bg-white/10'}`}
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

                <button
                  onClick={handleGenerateImage}
                  disabled={!imagePrompt.trim() || generatingImage || (useFaceRef && !refCharId)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
                >
                  {generatingImage
                    ? <><Loader size={12} className="animate-spin" /> Generando imagen…</>
                    : useFaceRef
                      ? <><FlaskConical size={12} /> Generar (BETA)</>
                      : <><ImageIcon size={12} /> Generar imagen</>}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function StepPill({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <span
      className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
        done
          ? 'border-green-500/40 bg-green-500/10 text-green-400'
          : active
          ? 'border-accent/40 bg-accent/10 text-accent'
          : 'border-border text-text-muted'
      }`}
    >
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
