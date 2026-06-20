import React, { useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Copy, Edit2, RefreshCw, Trash2, Check, Bug, X, Pin, Volume2, VolumeX, Loader, Wand2, Image as ImageIcon, Zap, ChevronDown, RotateCcw, Play, Square, Pause, Download, Share2, Upload, Brain } from 'lucide-react';
import type { Message, ChatMessage } from '@rpgspeak/shared';
import { Avatar } from '../ui/Avatar.tsx';
import { useMutation, useQuery } from '@tanstack/react-query';
import { messagesApi } from '../../api/conversations.ts';
import { settingsApi } from '../../api/settings.ts';
import { generateApi } from '../../api/generate.ts';
import { useChatStore } from '../../stores/chat.store.ts';
import { useUiStore } from '../../stores/ui.store.ts';
import { useAuthStore } from '../../stores/auth.store.ts';
import { SceneDebugModal } from './SceneDebugModal.tsx';

import { useTtsStore } from '../../stores/tts.store.ts';
import { useLightboxStore } from '../../stores/lightbox.store.ts';

// Configure marked for safe rendering (marked v12 requires .use() — setOptions is a no-op)
marked.use({ breaks: true, gfm: true });

interface MessageItemProps {
  message: Message;
  characterName?: string;
  characterAvatar?: string | null;
  groupCharacters?: import('@rpgspeak/shared').Character[];
  isStreaming?: boolean;
  /** When true, the message receives a brief highlight flash (search result). */
  highlighted?: boolean;
}

export function MessageItem({ message, characterName, characterAvatar, groupCharacters, isStreaming, highlighted }: MessageItemProps) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const [showPrompt, setShowPrompt] = useState(false);

  // Scene images — array stored in metadata; backward compat with legacy sceneImageUrl
  const sceneImages: Array<{ url: string; pending?: boolean; token?: string; description?: string }> =
    React.useMemo(() => {
      const meta = message.metadata ?? {};
      if (Array.isArray((meta as any).sceneImages)) return (meta as any).sceneImages;
      const legacyUrl = (meta as any).sceneImageUrl as string | undefined;
      if (legacyUrl) return [{ url: legacyUrl, pending: (meta as any).sceneImagePending ?? false, description: (meta as any).sceneDescription }];
      return [];
    }, [message.metadata]);

  const hasPending   = sceneImages.some(i => i.pending);
  const lastDesc     = sceneImages.length > 0 ? (sceneImages[sceneImages.length - 1].description ?? '') : '';

  const [showScenePanel,  setShowScenePanel]  = useState(false);
  const [showSceneDebug,  setShowSceneDebug]  = useState(false);
  const [editablePrompt,  setEditablePrompt]  = useState('');
  const [generatingScene, setGeneratingScene] = useState(false);
  const [uploadingScene,  setUploadingScene]  = useState(false);
  const [sceneError,      setSceneError]      = useState<string | null>(null);
  const uploadInputRef = React.useRef<HTMLInputElement>(null);

  // Keep editable prompt in sync with most recent generation description
  React.useEffect(() => {
    if (lastDesc) setEditablePrompt(lastDesc);
  }, [lastDesc]);

  const activeConversation = useChatStore((s) => s.activeConversation);
  const removeMessage = useChatStore((s) => s.removeMessage);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const regenerate = useChatStore((s) => s.regenerate);

  // Poll while any image in the array is pending (waiting for 4K final)
  React.useEffect(() => {
    if (!hasPending || !message.id) return;
    const interval = setInterval(async () => {
      try {
        const updated = await messagesApi.get(message.id);
        const imgs: any[] = Array.isArray((updated.metadata as any)?.sceneImages)
          ? (updated.metadata as any).sceneImages
          : [];
        if (!imgs.some((i: any) => i.pending)) {
          updateMessage(message.id, { metadata: updated.metadata });
          clearInterval(interval);
        }
      } catch { /* ignore transient errors */ }
    }, 4_000);
    return () => clearInterval(interval);
  }, [hasPending, message.id, updateMessage]);

  // TTS — settings leídos de cache (sin petición extra)
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const showTokenCount  = useUiStore((s) => s.appearance.showTokenCount);
  const showTimestamps  = useUiStore((s) => s.appearance.showTimestamps);
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const { speak, playingId, loadingId } = useTtsStore();
  const openLightbox = useLightboxStore((s) => s.open);
  const isTtsPlaying = playingId === message.id;
  const isTtsLoading = loadingId === message.id;

  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isError = Boolean(message.metadata?.isError);
  const isNarrator = !isUser && Boolean(message.metadata?.narrator);

  // Name → character lookup for speaker-avatar injection
  const charNameMap = useMemo(() => {
    const map = new Map<string, { name: string; avatar?: string | null }>();
    for (const c of groupCharacters ?? []) {
      map.set(c.name.toLowerCase(), { name: c.name, avatar: c.avatar });
    }
    return map;
  }, [groupCharacters]);

  const html = useMemo(() => {
    if (!message.content) return '';

    let content = message.content;

    if (isNarrator) {
      // Fix 1: normalize "**Name: **" → "**Name:**"
      // The LLM sometimes adds a space before the closing ** which breaks marked's bold parsing.
      content = content.replace(/\*\*([^*\n]+?):\s*\*\*/g, '**$1:**');

      // Fix 2: normalize "* narration text" / "* narration text *" at line start → "*narration text*"
      // Asterisk+space at line start is markdown list syntax, but the LLM intends italic.
      // [^*\n] prevents matching lines that start "* **Name:**" (speaker lines).
      content = content.replace(
        /^[ \t]*\* ([^*\n]+?)[ \t]*\*?[ \t]*$/gm,
        (_, text) => `*${text.trim()}*`,
      );
    }

    // Step 1 — parse markdown.
    // Pass breaks:true explicitly per-call as defence-in-depth (marked.use() above is the primary).
    // Without breaks:true, lines without blank separators merge into one <p> and break
    // both the stage-direction CSS rule and the speaker regex below.
    const parseResult = marked.parse(content, { breaks: true });
    const raw = typeof parseResult === 'string' ? parseResult : '';
    if (!raw) return '';

    // Step 2 — sanitize LLM output (strip unsafe tags/attrs)
    let clean = DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: ['p','br','strong','em','code','pre','ul','ol','li','blockquote','h1','h2','h3','a','hr'],
      ALLOWED_ATTR: ['href','target'],
    });

    // Step 3 — fallback: convert any literal *text* the parser missed.
    // Uses negative lookahead/lookbehind so it ONLY matches single asterisks,
    // never touching **bold** patterns that remained as literals.
    clean = clean.replace(/(?<!\*)\*(?!\*)([^*<>\n]+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

    if (!isNarrator) return clean;

    // Step 4 — for narrator messages: mark stage-direction paragraphs explicitly.
    // A <p> whose only content is an <em> block gets the class so the CSS rule
    // (.prose p:has(> em:only-child)) works even in browsers without :has() support,
    // and survives paragraph merging when breaks:true wasn't applied by the parser.
    clean = clean.replace(
      /<p>(\s*<em>[^<]*(?:<\/em>)\s*)<\/p>/gi,
      '<p class="stage-direction">$1</p>',
    );

    // Step 5 — inject trusted speaker-avatar markup.
    // Handles both LLM variants:
    //   **Name:**  → marked → <strong>Name:</strong>   (colon inside bold — normal)
    //   **Name**:  → marked → <strong>Name</strong>:   (colon outside bold — LLM variant)
    return clean.replace(
      /<p(?:\s[^>]*)?>[ \t]*<strong>([^<:]+?)(?::<\/strong>|<\/strong>:)/gi,
      (match, rawName) => {
        const name = rawName.trim();
        const char = charNameMap.get(name.toLowerCase());
        const avatarEl = char?.avatar
          ? `<img src="${char.avatar}" alt="${char.name}" />`
          : `<span class="speaker-initials">${name.charAt(0).toUpperCase()}</span>`;
        return `<p class="speaker-line"><span class="speaker-tag">${avatarEl}<strong>${char?.name ?? name}:</strong></span>`;
      }
    );
  }, [message.content, isNarrator, charNameMap]);

  const updateMutation = useMutation({
    mutationFn: () => messagesApi.update(message.id, editContent),
    onSuccess: (updated) => {
      updateMessage(message.id, { content: updated.content });
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => messagesApi.delete(message.id),
    onSuccess: () => removeMessage(message.id),
  });

  async function handleGenerateSceneImage(
    customPrompt?: string,
    opts?: { useFaceReference?: boolean; referenceCharId?: string; workflowName?: string },
  ) {
    if (!activeConversation?.id) return;
    setGeneratingScene(true);
    setSceneError(null);
    try {
      const result = await generateApi.sceneImage(
        activeConversation.id, message.id,
        opts?.workflowName, customPrompt,
        opts?.useFaceReference, opts?.referenceCharId,
      );
      const newEntry = { url: result.imageUrl, pending: result.pending ?? false, description: result.sceneDescription };
      updateMessage(message.id, {
        metadata: {
          ...(message.metadata ?? {}),
          sceneImages: [...sceneImages, newEntry],
        },
      });
      setEditablePrompt(result.sceneDescription);
      setShowScenePanel(true);
    } catch (err) {
      setSceneError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setGeneratingScene(false);
    }
  }

  async function handleDeleteSceneImage(imageUrl: string) {
    if (!activeConversation?.id) return;
    try {
      await generateApi.deleteSceneImage(activeConversation.id, message.id, imageUrl);
      const remaining = sceneImages.filter(i => i.url !== imageUrl);
      updateMessage(message.id, {
        metadata: { ...(message.metadata ?? {}), sceneImages: remaining },
      });
      if (remaining.length === 0) setShowScenePanel(false);
    } catch (err) {
      setSceneError(err instanceof Error ? err.message : 'Error al eliminar');
    }
  }

  async function handleUploadSceneImage(file: File) {
    if (!activeConversation?.id) return;
    setUploadingScene(true);
    setSceneError(null);
    try {
      const result = await generateApi.uploadSceneImage(activeConversation.id, message.id, file);
      updateMessage(message.id, {
        metadata: { ...(message.metadata ?? {}), sceneImageUrl: result.imageUrl },
      });
      setShowScenePanel(false);
    } catch (err) {
      setSceneError(err instanceof Error ? err.message : 'Error al subir la imagen');
    } finally {
      setUploadingScene(false);
    }
  }

  async function copyContent() {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (isSystem) {
    if (message.metadata?.isAnchor) {
      return (
        <div className="group mx-2 sm:mx-4 my-3">
          <div className="rounded-xl border border-accent/30 overflow-hidden" style={{ background: 'rgba(var(--accent-rgb,99,102,241),0.06)' }}>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-accent/20">
              <Pin size={11} className="text-accent flex-shrink-0" />
              <span className="text-[10px] font-semibold text-accent uppercase tracking-wider">Nota de contexto</span>
              <button
                onClick={() => deleteMutation.mutate()}
                className="ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 text-text-muted hover:text-red-400 transition-all"
                title="Eliminar nota"
              >
                <Trash2 size={10} />
              </button>
            </div>
            <pre className="px-3 py-2.5 text-xs text-text-secondary whitespace-pre-wrap font-mono leading-relaxed">
              {message.content}
            </pre>
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-center my-2">
        <div className="px-3 py-1 rounded-full text-xs text-text-muted border border-border">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`group flex gap-3 sm:gap-4 px-2 sm:px-4 py-2 sm:py-3 hover:bg-white/2 transition-colors animate-fade-in ${
        isUser ? 'flex-row-reverse' : ''
      } ${highlighted ? 'msg-highlight' : ''}`}
    >
      {/* Avatar */}
      <div className="flex-shrink-0 mt-0.5">
        {isUser ? (
          <Avatar name="You" size="md" />
        ) : (
          <Avatar name={characterName ?? 'AI'} src={characterAvatar} size="md" expandable />
        )}
      </div>

      {/* Bubble */}
      <div className={`flex flex-col gap-1 max-w-[88%] sm:max-w-[75%] min-w-0 ${isUser ? 'items-end' : 'items-start'}`}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-secondary">
            {isUser ? 'You' : (characterName ?? 'Assistant')}
          </span>
          {showTimestamps && message.createdAt && (
            <span className="text-[10px] text-text-muted tabular-nums">
              {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {message.metadata?.generationTime && (
            <span className="text-[10px] text-text-muted">
              {Math.round((message.metadata.generationTime as number) / 1000 * 10) / 10}s
            </span>
          )}
          {!isUser && showTokenCount && message.tokens > 0 && (
            <TokenBadge message={message} />
          )}
        </div>

        <div
          className={`relative rounded-2xl px-4 py-2.5 text-sm ${
            isUser
              ? 'bubble-user text-white'
              : isError
              ? 'bubble-char border border-red-500/40 text-red-400'
              : 'bubble-char border border-border text-white'
          }`}
          style={
            isUser
              ? { background: 'var(--accent)' }
              : isError
              ? { background: 'rgba(239,68,68,0.08)' }
              : { background: 'var(--surface-2)' }
          }
        >
          {editing ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full bg-transparent text-sm resize-none focus:outline-none min-w-[200px]"
                rows={3}
                autoFocus
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setEditing(false)}
                  className="text-xs text-text-muted hover:text-text-primary"
                >
                  Cancel
                </button>
                <button
                  onClick={() => updateMutation.mutate()}
                  className="text-xs text-accent hover:text-accent-hover font-medium"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* ThinkBlock — shown when think content is arriving or was saved */}
              {!isUser && message.metadata?.thinkContent && (
                <ThinkBlock
                  content={message.metadata.thinkContent as string}
                  isThinking={Boolean(message.metadata?.isThinking)}
                />
              )}
              {/* Loading state: show Brain indicator while waiting for first token (think or content) */}
              {isStreaming && !isUser && !message.metadata?.thinkContent && !message.content ? (
                <GeneratingIndicator />
              ) : message.content ? (
                <div
                  className={`prose${isNarrator ? ' narrator-content' : ''}`}
                  dangerouslySetInnerHTML={{ __html: html || message.content }}
                />
              ) : null}
              {isStreaming && message.content && (
                <span className="inline-block w-0.5 h-4 bg-current opacity-70 animate-pulse ml-0.5 align-middle" />
              )}
            </>
          )}

          {/* ── TTS player inline ────────────────────────────────────────── */}
          {!isUser && !isStreaming && !editing && (
            <TtsPlayerBar
              messageId={message.id}
              text={message.content}
              voiceId={settings?.ttsSettings?.defaultVoiceId ?? undefined}
              speed={settings?.ttsSettings?.speed}
              temperature={settings?.ttsSettings?.temperature}
              replacements={settings?.ttsSettings?.replacements}
            />
          )}
        </div>

        {/* Affinity change indicator */}
        {!isUser && !isStreaming && (message.metadata?.affinityUpdates as import('@rpgspeak/shared').AffinityUpdate[] | undefined)?.length ? (
          <AffinityChangeBar
            updates={message.metadata!.affinityUpdates as import('@rpgspeak/shared').AffinityUpdate[]}
            characters={groupCharacters ?? []}
          />
        ) : null}

        {/* Fast LLM debug panel — solo admin */}
        {isAdmin && !isUser && !isStreaming && message.metadata?.fastLlmDebug != null && (
          <FastLlmDebugPanel debug={message.metadata.fastLlmDebug as FastLlmDebug} messageId={message.id} />
        )}

        {/* Actions */}
        {!isStreaming && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <ActionButton icon={copied ? Check : Copy} onClick={copyContent} title="Copy" />
            <ActionButton icon={Edit2} onClick={() => { setEditContent(message.content); setEditing(true); }} title="Edit" />
            {isAdmin && !isUser && Boolean(message.metadata?.promptMessages) && (
              <ActionButton icon={Bug} onClick={() => setShowPrompt(true)} title="Debug prompt" />
            )}
            {!isUser && (
              <ActionButton
                icon={RefreshCw}
                onClick={() => regenerate(message.id, message.characterId)}
                title="Regenerar respuesta"
                disabled={isStreaming}
              />
            )}
            {!isUser && !isError && (
              <>
                <ActionButton
                  icon={generatingScene ? Loader : ImageIcon}
                  onClick={() => setShowSceneDebug(true)}
                  title="Generar imagen de escena"
                  spin={generatingScene}
                />
                {/* Subir imagen externa */}
                <ActionButton
                  icon={uploadingScene ? Loader : Upload}
                  onClick={() => uploadInputRef.current?.click()}
                  title="Subir imagen"
                  spin={uploadingScene}
                />
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleUploadSceneImage(file);
                    // Limpiar para que se pueda subir el mismo archivo de nuevo
                    e.target.value = '';
                  }}
                />
              </>
            )}
            <ActionButton
              icon={Trash2}
              onClick={() => deleteMutation.mutate()}
              title="Delete"
              danger
            />
          </div>
        )}

        {/* Scene images gallery + prompt panel */}
        {sceneError && (
          <p className="text-[11px] text-red-400 mt-1">{sceneError}</p>
        )}
        {sceneImages.length > 0 && (
          <div className="mt-2 space-y-1.5" style={{ maxWidth: '480px' }}>
            {/* Thumbnail strip */}
            <div className="flex flex-wrap gap-2">
              {sceneImages.map((img, idx) => (
                <div
                  key={img.url}
                  className="relative rounded-lg overflow-hidden border border-border flex-shrink-0"
                  style={{ width: sceneImages.length === 1 ? '100%' : '120px', aspectRatio: sceneImages.length === 1 ? 'auto' : '1' }}
                >
                  <img
                    src={img.url}
                    alt={`Imagen de escena ${idx + 1}`}
                    className="w-full h-full object-cover block"
                    style={{ cursor: img.pending ? 'default' : 'zoom-in' }}
                    onClick={() => !img.pending && openLightbox(img.url, `Imagen de escena ${idx + 1}`)}
                  />
                  {img.pending && (
                    <div className="absolute inset-0 flex items-center justify-center"
                      style={{ background: 'rgba(0,0,0,0.45)' }}>
                      <div className="flex flex-col items-center gap-1">
                        <Loader size={16} className="animate-spin text-white" />
                        <span className="text-[9px] text-white font-medium">4K…</span>
                      </div>
                    </div>
                  )}
                  {!img.pending && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteSceneImage(img.url); }}
                      className="absolute top-1 right-1 rounded-full p-1 text-white hover:bg-red-500 transition-colors"
                      style={{ background: 'rgba(0,0,0,0.55)' }}
                      title="Eliminar imagen"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Toggle prompt panel */}
            <button
              onClick={() => setShowScenePanel((v) => !v)}
              className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary transition-colors px-1"
            >
              <Wand2 size={9} />
              {showScenePanel ? 'Ocultar prompt' : 'Generar otra imagen'}
            </button>

            {showScenePanel && (
              <div
                className="rounded-xl border border-border p-3 space-y-2"
                style={{ background: 'var(--surface-2)' }}
              >
                <textarea
                  value={editablePrompt}
                  onChange={(e) => setEditablePrompt(e.target.value)}
                  rows={5}
                  className="w-full text-xs bg-transparent border border-border rounded-lg px-2 py-1.5 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-none font-mono leading-relaxed"
                  placeholder="Describe la nueva imagen..."
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleGenerateSceneImage(editablePrompt)}
                    disabled={generatingScene || !editablePrompt.trim()}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
                  >
                    {generatingScene
                      ? <Loader size={11} className="animate-spin" />
                      : <Wand2 size={11} />}
                    {generatingScene ? 'Generando...' : 'Generar imagen'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Prompt debug modal */}
        {showPrompt && (
          <PromptModal
            messages={message.metadata.promptMessages as ChatMessage[]}
            model={message.metadata.model as string | undefined}
            onClose={() => setShowPrompt(false)}
          />
        )}

        {/* Scene image debug modal */}
        {showSceneDebug && activeConversation?.id && (
          <SceneDebugModal
            conversationId={activeConversation.id}
            messageId={message.id}
            onDone={(imageUrl, sceneDescription, pending) => {
              const newEntry = { url: imageUrl, pending: pending ?? false, description: sceneDescription };
              updateMessage(message.id, {
                metadata: {
                  ...(message.metadata ?? {}),
                  sceneImages: [...sceneImages, newEntry],
                },
              });
              setEditablePrompt(sceneDescription);
              setShowScenePanel(false);
              if (!pending) setShowSceneDebug(false);
            }}
            onClose={() => setShowSceneDebug(false)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Affinity Change Bar ──────────────────────────────────────────────────────

function AffinityChangeBar({
  updates,
  characters,
}: {
  updates: import('@rpgspeak/shared').AffinityUpdate[];
  characters: import('@rpgspeak/shared').Character[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-1">
      {updates.map((u) => {
        const char = characters.find((c) => c.id === u.characterId);
        const name = char?.name ?? u.characterId;
        const prev = u.previousAffinity ?? u.newAffinity;
        const delta = u.newAffinity - prev;
        const isPositive = delta > 0;
        const isNeutral  = delta === 0;

        const colors = isNeutral
          ? 'bg-white/5 border-white/10 text-text-muted'
          : isPositive
          ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
          : 'bg-red-500/10 border-red-500/25 text-red-400';

        return (
          <span
            key={u.characterId}
            className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-mono ${colors}`}
            title={`${name}: ${prev} → ${u.newAffinity}`}
          >
            <span className="text-[9px] opacity-70">{isPositive ? '▲' : isNeutral ? '●' : '▼'}</span>
            {name}
            {!isNeutral && (
              <span className="font-semibold">
                {isPositive ? '+' : ''}{delta}
              </span>
            )}
            <span className="opacity-50">({u.newAffinity}/100)</span>
          </span>
        );
      })}
    </div>
  );
}

// ─── Fast LLM Debug Panel ─────────────────────────────────────────────────────

type FastLlmDebug = { prompt: string; response: string } | string;

function FastLlmDebugPanel({ debug: initialDebug, messageId }: { debug: FastLlmDebug; messageId: string }) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'response' | 'prompt'>('response');
  const [debug, setDebug] = useState(initialDebug);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const updateCharacterAffinities = useChatStore((s) => s.updateCharacterAffinities);

  // Support both legacy string format and new object format
  const response = typeof debug === 'string' ? debug : debug.response;
  const prompt    = typeof debug === 'string' ? null  : debug.prompt;
  const isPending = response === '(timeout)' || response.startsWith('(error:');

  async function handleRetry() {
    setRetrying(true);
    setRetryError(null);
    try {
      const result = await generateApi.analyzeMessage(messageId);
      setDebug({ prompt: result.rawPrompt ?? '', response: result.rawResponse });
      if (result.affinityUpdates?.length) {
        updateCharacterAffinities(result.affinityUpdates);
      }
      setOpen(true);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="mt-1.5 rounded-lg border border-accent/20 overflow-hidden text-left">
      {/* Header row */}
      <div className="flex items-center">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center gap-2 px-3 py-1.5 text-[10px] text-accent/60 hover:text-accent hover:bg-accent/5 transition-colors"
        >
          <Zap size={10} />
          <span className="font-mono">LLM Rápido · análisis</span>
          {isPending && !retrying && (
            <span className="ml-1 text-amber-400/80 font-semibold">(timeout)</span>
          )}
          <ChevronDown size={10} className={`ml-auto flex-shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
        </button>
        {(isPending || retryError) && (
          <button
            onClick={handleRetry}
            disabled={retrying}
            title="Reintentar análisis"
            className="flex items-center gap-1 px-2 py-1.5 text-[10px] text-amber-400/80 hover:text-amber-300 hover:bg-amber-400/10 transition-colors disabled:opacity-40 border-l border-accent/20 flex-shrink-0"
          >
            <RotateCcw size={10} className={retrying ? 'animate-spin' : ''} />
            <span className="font-mono">{retrying ? 'Analizando…' : 'Reintentar'}</span>
          </button>
        )}
      </div>

      {retryError && (
        <p className="px-3 pb-2 text-[10px] text-red-400 font-mono border-t border-accent/10">{retryError}</p>
      )}

      {open && (
        <div className="border-t border-accent/10">
          {/* Tab bar — only show when we have a prompt */}
          {prompt != null && (
            <div className="flex border-b border-accent/10">
              {(['response', 'prompt'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-1 text-[10px] font-mono transition-colors ${
                    activeTab === tab
                      ? 'text-accent border-b border-accent -mb-px bg-accent/5'
                      : 'text-text-muted hover:text-text-primary'
                  }`}
                >
                  {tab === 'response' ? 'Respuesta' : 'Prompt enviado'}
                </button>
              ))}
            </div>
          )}
          <pre className="px-3 py-3 text-[10px] text-text-muted font-mono whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto">
            {activeTab === 'prompt' && prompt != null ? prompt : response}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

// ─── TTS Player Bar ───────────────────────────────────────────────────────────

function TtsPlayerBar({ messageId, text, voiceId, speed, temperature, replacements }: {
  messageId:    string;
  text:         string;
  voiceId?:     string;
  speed?:       number;
  temperature?: number;
  replacements?: import('@rpgspeak/shared').TtsTextReplacement[];
}) {
  const {
    speak, pause, resume, stop, seek, shareOrDownload,
    playingId, pausedId, loadingId,
    currentTime, duration, cachedKeys,
  } = useTtsStore();

  const isPlaying = playingId === messageId;
  const isPaused  = pausedId  === messageId;
  const isLoading = loadingId === messageId;
  const isActive  = isPlaying || isPaused;

  const effectiveVoiceId = voiceId ?? 'edge_elvira';
  const effectiveSpeed   = speed   ?? 1.0;
  const cKey   = `${messageId}:${effectiveVoiceId}:${effectiveSpeed.toFixed(1)}`;
  const cached = cachedKeys.has(cKey);

  // El botón principal: genera, reproduce, pausa o reanuda según estado
  function handleMainClick() {
    if (isPlaying)       pause();
    else if (isPaused)   resume();
    else                 speak(messageId, text, { voiceId, speed, temperature, replacements });
  }

  function handleSeek(e: React.MouseEvent<HTMLDivElement>) {
    if (!isActive || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(pct * duration);
  }

  function fmt(s: number) {
    if (!isFinite(s) || s < 0) return '0:00';
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Determinar el icono y label del botón principal
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator;
  let btnIcon: React.ReactNode;
  let btnLabel: string;
  let btnClass: string;

  if (isLoading) {
    btnIcon  = <Loader size={11} className="animate-spin" />;
    btnLabel = 'Generando…';
    btnClass = 'bg-white/8 text-text-muted border-border cursor-wait';
  } else if (isPlaying) {
    btnIcon  = <Pause size={11} className="fill-current" />;
    btnLabel = 'Pausar';
    btnClass = 'bg-accent/20 text-accent border-accent/40 hover:bg-accent/30';
  } else if (isPaused) {
    btnIcon  = <Play size={11} className="fill-current" />;
    btnLabel = 'Continuar';
    btnClass = 'bg-accent/15 text-accent border-accent/30 hover:bg-accent/25';
  } else if (cached) {
    btnIcon  = <Play size={11} className="fill-current" />;
    btnLabel = 'Reproducir';
    btnClass = 'bg-white/8 text-text-muted border-border hover:bg-white/12 hover:text-text-primary hover:border-accent/40';
  } else {
    btnIcon  = <Play size={11} className="fill-current" />;
    btnLabel = 'Generar audio';
    btnClass = 'bg-white/8 text-text-muted border-border hover:bg-white/12 hover:text-text-primary hover:border-accent/40';
  }

  return (
    <div className="mt-2 pt-2 border-t border-white/8 space-y-1.5">
      {/* Fila: botón principal + barra + tiempo + compartir */}
      <div className="flex items-center gap-2">
        {/* Botón principal */}
        <button
          onClick={handleMainClick}
          disabled={isLoading}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium transition-all flex-shrink-0 border ${btnClass}`}
          title={btnLabel}
        >
          {btnIcon} {btnLabel}
        </button>

        {/* Barra de progreso — siempre a todo el ancho, clicable cuando activa */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div
            className={`flex-1 h-2 rounded-full overflow-hidden transition-colors ${
              isActive ? 'bg-white/15 cursor-pointer' : 'bg-white/6'
            }`}
            onClick={handleSeek}
            title={isActive ? 'Clic para saltar' : undefined}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-200 ${
                isPaused ? 'bg-accent/50' : 'bg-accent'
              }`}
              style={{ width: `${isActive ? progress : 0}%` }}
            />
          </div>
          {/* Tiempo — cuando activo */}
          {isActive && (
            <span className="text-[10px] text-text-muted tabular-nums flex-shrink-0 select-none">
              {fmt(currentTime)}{duration > 0 ? ` / ${fmt(duration)}` : ''}
            </span>
          )}
        </div>

        {/* Botón compartir/descargar — solo si el audio está en caché */}
        {cached && (
          <button
            onClick={() => shareOrDownload(messageId, { voiceId, speed })}
            className="flex-shrink-0 p-1.5 rounded-lg text-text-muted hover:text-accent hover:bg-accent/10 transition-colors border border-transparent hover:border-accent/30"
            title={canShare ? 'Compartir audio' : 'Descargar audio'}
          >
            {canShare ? <Share2 size={13} /> : <Download size={13} />}
          </button>
        )}
      </div>
    </div>
  );
}

function ActionButton({ icon: Icon, onClick, title, danger = false, spin = false, disabled = false }: {
  icon: React.ElementType; onClick: () => void; title: string; danger?: boolean; spin?: boolean; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`p-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        danger
          ? 'hover:bg-red-500/10 text-text-muted hover:text-red-400'
          : 'hover:bg-white/8 text-text-muted hover:text-text-primary'
      }`}
    >
      <Icon size={12} className={spin ? 'animate-spin' : undefined} />
    </button>
  );
}

function GeneratingIndicator() {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <Brain size={15} className="text-accent animate-brain-spin opacity-80" />
      <span className="flex gap-1">
        <span className="think-dot" />
        <span className="think-dot" />
        <span className="think-dot" />
      </span>
    </div>
  );
}

function ThinkBlock({ content, isThinking }: { content: string; isThinking: boolean }) {
  const [open, setOpen] = useState(false);

  // Always collapsed by default — never auto-expand, even during streaming.
  // When thinking finishes, collapse in case the user had opened it mid-stream.
  React.useEffect(() => {
    if (!isThinking) setOpen(false);
  }, [isThinking]);

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Ocultar razonamiento' : 'Ver razonamiento'}
        className="flex items-center gap-1.5 opacity-40 hover:opacity-70 transition-opacity"
      >
        <Brain
          size={11}
          className={isThinking ? 'text-accent animate-brain-spin' : (open ? 'text-accent' : 'text-text-muted')}
        />
        {isThinking && (
          <span className="flex gap-1">
            <span className="think-dot" style={{ width: 4, height: 4 }} />
            <span className="think-dot" style={{ width: 4, height: 4 }} />
            <span className="think-dot" style={{ width: 4, height: 4 }} />
          </span>
        )}
        <ChevronDown
          size={10}
          className={`text-text-muted transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="mt-1.5 pl-3 border-l border-border text-xs text-text-muted leading-relaxed whitespace-pre-wrap opacity-70">
          {content}
        </div>
      )}
    </div>
  );
}

const ROLE_STYLES: Record<string, { label: string; badge: string; border: string; bg: string }> = {
  system:    { label: 'system',    badge: 'bg-purple-500/20 text-purple-300 border border-purple-500/30', border: 'border-purple-500/20', bg: 'bg-purple-500/5' },
  user:      { label: 'user',      badge: 'bg-blue-500/20 text-blue-300 border border-blue-500/30',       border: 'border-blue-500/20',   bg: 'bg-blue-500/5' },
  assistant: { label: 'assistant', badge: 'bg-green-500/20 text-green-300 border border-green-500/30',    border: 'border-green-500/20',  bg: 'bg-green-500/5' },
};

// ─── Prompt structure grouping (mirrors "Estructura de la petición al LLM" in Ajustes → Generación) ───

interface PromptGroup {
  title: string;
  hint?: string;
  items: ChatMessage[];
  defaultOpen?: boolean;
}

function classifyHeaderPart(content: string): { title: string; hint?: string } {
  const c = content.trim();
  if (/^# Character:/.test(c)) {
    const m = c.match(/^# Character:\s*(.+)/);
    return { title: `Personaje${m ? `: ${m[1]}` : ''}` };
  }
  if (/^## Personajes en la aventura/.test(c)) return { title: 'Personajes (Game Master)' };
  if (/^## Personajes presentes en la escena/.test(c)) return { title: 'Personajes (Narrador)' };
  if (/^## Otros personajes presentes/.test(c)) return { title: 'Otros personajes del grupo' };
  if (/^## Contexto de aventura activa/.test(c)) return { title: 'Aviso de aventura' };
  if (/^# Story Context:/.test(c)) {
    const m = c.match(/^# Story Context:\s*(.+)/);
    return { title: `Lore / Historia${m ? `: ${m[1]}` : ''}` };
  }
  if (/^## Memorias activas/.test(c)) return { title: 'Memorias activas (bloque básico)' };
  if (/^Recuerda que el usuario se llama/.test(c)) return { title: 'Nombre del usuario' };
  if (c.startsWith('[Example conversations:]')) return { title: 'Ejemplos de diálogo (few-shot)' };
  return { title: 'Prompt de sistema global / personaje', hint: 'Incluye el prompt global, formato de respuesta y/o instrucciones del personaje' };
}

function classifyFooterPart(content: string): string {
  const c = content.trim();
  if (/^## Historia hasta ahora/.test(c)) return 'Resumen de sucesos';
  if (/^## Índice de contexto/.test(c)) return 'Índice de Contexto';
  if (/^## UBICACIÓN/.test(c)) return 'Coherencia espacial (ubicación)';
  if (/^## COHERENCIA DE OBJETOS/.test(c)) return 'Coherencia de objetos';
  if (/ESTADO EMOCIONAL ACTUAL/.test(c)) return 'Afinidad / estado emocional';
  if (/^## Hechos establecidos|memoria/i.test(c)) return 'Memorias inyectadas';
  return 'Estilo de narración / directiva adicional';
}

function groupPromptMessages(messages: ChatMessage[]): PromptGroup[] {
  const groups: PromptGroup[] = [];
  if (messages.length === 0) return groups;

  let i = 0;

  // Header: leading system message — split by the '---' separators used to join systemParts
  if (messages[0].role === 'system') {
    const parts = messages[0].content.split('\n\n---\n\n');
    for (const part of parts) {
      if (!part.trim()) continue;
      const { title, hint } = classifyHeaderPart(part);
      groups.push({ title, hint, items: [{ role: 'system', content: part }] });
    }
    i = 1;
  }

  let convBuffer: ChatMessage[] = [];
  const flushConv = () => {
    if (convBuffer.length === 0) return;
    if (convBuffer.length === 1 && convBuffer[0].role === 'user') {
      groups.push({ title: 'Último mensaje del jugador', items: convBuffer, defaultOpen: true });
    } else {
      groups.push({ title: `Historial de conversación (${convBuffer.length} mensajes)`, items: [...convBuffer] });
    }
    convBuffer = [];
  };

  for (; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'system') {
      flushConv();
      groups.push({ title: classifyFooterPart(m.content), items: [m] });
    } else {
      convBuffer.push(m);
    }
  }
  flushConv();
  return groups;
}

function PromptAccordionGroup({ group, defaultOpen }: { group: PromptGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const chars = group.items.reduce((sum, m) => sum + m.content.length, 0);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-surface-2 hover:bg-white/5 transition-colors text-left"
      >
        <ChevronDown size={13} className={`text-text-muted shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-xs font-medium text-text-primary">{group.title}</span>
        {group.hint && <span className="text-[10px] text-text-muted hidden sm:inline">— {group.hint}</span>}
        <span className="text-[11px] text-text-muted ml-auto shrink-0">
          {group.items.length > 1 ? `${group.items.length} msgs · ` : ''}{chars.toLocaleString()} chars
        </span>
      </button>
      {open && (
        <div className="p-2 space-y-2">
          {group.items.map((msg, i) => {
            const style = ROLE_STYLES[msg.role] ?? ROLE_STYLES.user;
            return (
              <div key={i} className={`rounded-lg border ${style.border} ${style.bg} overflow-hidden`}>
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5">
                  <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${style.badge}`}>
                    {style.label}
                  </span>
                  <span className="text-[11px] text-text-muted ml-auto">{msg.content.length} chars</span>
                </div>
                <pre className="p-3 text-xs text-text-primary font-mono whitespace-pre-wrap break-words leading-relaxed">
                  {msg.content}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PromptModal({ messages, model, onClose }: { messages: ChatMessage[]; model?: string; onClose: () => void }) {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const groups = useMemo(() => groupPromptMessages(messages), [messages]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative w-full max-w-3xl rounded-xl border border-border flex flex-col animate-slide-up"
        style={{ background: 'var(--surface-1)', maxHeight: '85vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <Bug size={15} className="text-accent" />
            <span className="font-semibold text-sm">Prompt enviado a la IA</span>
            {model && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/20 font-mono">
                {model}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-text-muted">
              {messages.length} mensajes · {totalChars.toLocaleString()} chars
            </span>
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Scrollable messages, grouped into a collapsed-by-default accordion */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {groups.map((group, i) => (
            <PromptAccordionGroup key={i} group={group} defaultOpen={Boolean(group.defaultOpen)} />
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-5 py-3 border-t border-border flex-shrink-0">
          <button
            onClick={() => {
              const text = messages.map(m => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n---\n\n');
              navigator.clipboard.writeText(text);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-text-muted hover:text-text-primary hover:bg-white/8 transition-colors"
          >
            <Copy size={12} /> Copiar todo
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Token Badge ──────────────────────────────────────────────────────────────
function TokenBadge({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const total      = message.tokens;
  const prompt     = (message.metadata?.promptTokens     as number | undefined) ?? 0;
  const completion = (message.metadata?.completionTokens as number | undefined) ?? 0;
  const cached     = (message.metadata?.cachedTokens     as number | undefined) ?? 0;
  const hasCached  = cached > 0;

  const fmt = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  return (
    <div className="relative inline-flex">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Tokens consumidos"
        className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border transition-colors cursor-pointer
          ${hasCached
            ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/15'
            : 'text-text-muted border-border hover:bg-white/6'
          }`}
      >
        <Zap size={9} className={hasCached ? 'text-emerald-400' : 'text-text-muted'} />
        {fmt(total)}
        {hasCached && (
          <span className="text-emerald-400/80">↑{fmt(cached)}</span>
        )}
      </button>

      {open && (
        <div
          className="absolute bottom-full left-0 mb-1.5 z-50 min-w-[170px] rounded-xl border border-border bg-surface-1 shadow-xl text-xs p-3 flex flex-col gap-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between font-medium text-text-primary mb-0.5">
            <span>Tokens</span>
            <button onClick={() => setOpen(false)} className="text-text-muted hover:text-text-primary"><X size={11} /></button>
          </div>
          <Row label="Prompt"      value={prompt}     />
          <Row label="Respuesta"   value={completion} />
          <div className="border-t border-border/60 my-0.5" />
          <Row label="Total"       value={total}      bold />
          {hasCached && (
            <>
              <div className="border-t border-border/60 my-0.5" />
              <Row label="Caché ↑"   value={cached}   color="text-emerald-400" />
              <Row label="Ahorro"     value={`${Math.round(cached / Math.max(prompt, 1) * 100)}%`} color="text-emerald-400" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, bold, color }: { label: string; value: number | string; bold?: boolean; color?: string }) {
  return (
    <div className={`flex items-center justify-between gap-4 ${bold ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}>
      <span>{label}</span>
      <span className={color ?? ''}>{typeof value === 'number' ? value.toLocaleString('es-ES') : value}</span>
    </div>
  );
}
