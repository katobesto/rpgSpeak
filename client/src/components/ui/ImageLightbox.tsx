import { useEffect, useState, useRef } from 'react';
import { X, Download, RotateCcw, ChevronLeft, ChevronRight, Sparkles, Loader2, Trash2, Check, ChevronDown } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useLightboxStore } from '../../stores/lightbox.store.ts';
import { useImagePanZoom } from '../../hooks/useImagePanZoom.ts';
import { useBackHandler } from '../../hooks/useBackHandler.ts';
import { charactersApi } from '../../api/characters.ts';

export function ImageLightbox() {
  const { src, name, gallery, index, characterId, close, next, prev, addGenerated, removeFromGallery } = useLightboxStore();
  const { wrapRef, imgRef, reset, onMouseDown } = useImagePanZoom(!!src, src);
  const hasGallery = gallery.length > 1;
  const qc = useQueryClient();

  const [scenePrompt, setScenePrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [lastGeneratedPrompt, setLastGeneratedPrompt] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ value: number; max: number } | null>(null);
  const [livePreview, setLivePreview] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);

  // Reset the scene-generation panel whenever the lightbox targets a different character
  useEffect(() => {
    setScenePrompt('');
    setGenError(null);
    setLastGeneratedPrompt(null);
    setShowPrompt(false);
    setStatusMessage(null);
    setProgress(null);
    setLivePreview(null);
  }, [characterId]);

  // Cancel any in-flight generation stream on unmount
  useEffect(() => () => cancelRef.current?.(), []);

  // Cancel a pending delete-confirmation when the viewed image changes
  useEffect(() => { setConfirmDelete(false); }, [src]);

  // Escape to close, ←/→ to navigate the gallery (ignored while typing), mobile swipe-back
  useEffect(() => {
    if (!src) return;
    const handler = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'INPUT';
      if (e.key === 'Escape') close();
      else if (!typing && hasGallery && e.key === 'ArrowRight') next();
      else if (!typing && hasGallery && e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [src, close, next, prev, hasGallery]);
  useBackHandler(!!src, close);

  // Prevent body scroll while open
  useEffect(() => {
    document.body.style.overflow = src ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [src]);

  if (!src) return null;

  function handleGenerate() {
    if (!characterId || generating) return;
    setGenerating(true);
    setGenError(null);
    setLastGeneratedPrompt(null);
    setShowPrompt(false);
    setStatusMessage('Iniciando…');
    setProgress(null);
    setLivePreview(null);

    cancelRef.current = charactersApi.streamSceneImage(
      characterId,
      { scenePrompt: scenePrompt.trim() },
      (evt) => {
        if (evt.type === 'status') {
          setStatusMessage(evt.message);
          setProgress(null);
        } else if (evt.type === 'node') {
          setStatusMessage(evt.nodeName);
          setProgress(null);
        } else if (evt.type === 'progress') {
          setProgress({ value: evt.value, max: evt.max });
        } else if (evt.type === 'preview') {
          setLivePreview(evt.dataUrl);
        } else if (evt.type === 'done') {
          addGenerated(evt.imageUrl);
          setLastGeneratedPrompt(evt.generatedPrompt);
          qc.invalidateQueries({ queryKey: ['characters'] });
          // Deliberately keep scenePrompt as-is — the user may want to tweak it
          // and regenerate without retyping the whole scene.
          setGenerating(false);
          setStatusMessage(null);
          setProgress(null);
          setLivePreview(null);
        } else if (evt.type === 'error') {
          setGenError(evt.message);
          setGenerating(false);
          setStatusMessage(null);
          setProgress(null);
          setLivePreview(null);
        }
      },
    );
  }

  // Aborta la conexión SSE y devuelve el panel a estado inactivo. La generación
  // ya encolada en el proveedor de imagen (ComfyUI/bzComfy) puede seguir
  // corriendo en el servidor — esto solo deja de esperar/mostrar su resultado,
  // igual que el "Cancelar" de la generación de escena del chat.
  function handleCancel() {
    cancelRef.current?.();
    cancelRef.current = null;
    setGenerating(false);
    setStatusMessage(null);
    setProgress(null);
    setLivePreview(null);
  }

  async function handleDelete() {
    if (!characterId || !src || deleting) return;
    setDeleting(true);
    try {
      await charactersApi.removeImage(characterId, src);
      removeFromGallery(src);
      qc.invalidateQueries({ queryKey: ['characters'] });
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Error eliminando la imagen');
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  const progressPct = progress && progress.max > 0 ? Math.round((progress.value / progress.max) * 100) : null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.92)' }}
      onClick={close}
    >
      {/* Toolbar */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center justify-between px-5 py-3 z-10 pointer-events-none"
        style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.65), transparent)' }}
      >
        <span className="text-sm font-medium text-white/90 truncate max-w-[50vw] pointer-events-auto flex items-center gap-2">
          {name}
          {hasGallery && (
            <span className="text-white/50 tabular-nums font-normal">{index + 1} / {gallery.length}</span>
          )}
        </span>
        <div className="flex items-center gap-1 pointer-events-auto" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={reset}
            title="Restablecer zoom (doble clic / doble tap)"
            className="p-2 rounded-lg hover:bg-white/12 text-white/60 hover:text-white transition-colors"
          >
            <RotateCcw size={15} />
          </button>
          <a
            href={src}
            download={`${name}.png`}
            title="Descargar"
            className="p-2 rounded-lg hover:bg-white/12 text-white/60 hover:text-white transition-colors"
          >
            <Download size={15} />
          </a>
          {characterId && (
            confirmDelete ? (
              <>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  title="Confirmar: eliminar esta imagen"
                  className="flex items-center gap-1 px-2 py-2 rounded-lg bg-red-500/80 hover:bg-red-500 text-white text-xs font-medium disabled:opacity-50 transition-colors"
                >
                  {deleting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  Eliminar
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                  title="Cancelar"
                  className="p-2 rounded-lg hover:bg-white/12 text-white/60 hover:text-white transition-colors disabled:opacity-50"
                >
                  <X size={15} />
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                title="Eliminar esta imagen"
                className="p-2 rounded-lg hover:bg-red-500/20 text-white/60 hover:text-red-400 transition-colors"
              >
                <Trash2 size={15} />
              </button>
            )
          )}
          <button
            onClick={close}
            title="Cerrar (Esc)"
            className="p-2 rounded-lg hover:bg-white/12 text-white/60 hover:text-white transition-colors"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Viewer */}
      <div
        ref={wrapRef}
        className="w-full h-full flex items-center justify-center overflow-hidden"
        style={{ touchAction: 'none' }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={onMouseDown}
        onDoubleClick={reset}
      >
        <img
          ref={imgRef}
          src={src}
          alt={name}
          className="max-w-[95vw] max-h-[95vh] rounded-xl object-contain shadow-2xl"
          style={{ userSelect: 'none', transformOrigin: 'center center' }}
          draggable={false}
        />
      </div>

      {hasGallery && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); prev(); }}
            title="Anterior (←)"
            className="absolute left-3 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-black/40 hover:bg-black/60 text-white/70 hover:text-white transition-colors"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); next(); }}
            title="Siguiente (→)"
            className="absolute right-3 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-black/40 hover:bg-black/60 text-white/70 hover:text-white transition-colors"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}

      {characterId ? (
        <div
          className="absolute bottom-0 left-0 right-0 px-4 pt-8 pb-4 pointer-events-auto"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.85) 30%, transparent)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="max-w-xl mx-auto">
            {generating && (
              <div className="mb-2 flex items-center gap-3">
                {livePreview && (
                  <img src={livePreview} alt="Vista previa" className="w-12 h-12 rounded-md object-cover border border-white/20 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between text-[11px] text-white/60 mb-1">
                    <span className="truncate">{statusMessage ?? 'Generando…'}</span>
                    {progressPct !== null && <span className="tabular-nums flex-shrink-0 ml-2">{progressPct}%</span>}
                  </div>
                  <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-accent transition-all duration-200"
                      style={{ width: progressPct !== null ? `${progressPct}%` : '100%', ...(progressPct === null ? { animation: 'pulse 1.5s ease-in-out infinite' } : {}) }}
                    />
                  </div>
                </div>
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={scenePrompt}
                onChange={(e) => setScenePrompt(e.target.value)}
                placeholder="Describe una escena o pose (opcional) — p.ej. «sentada en un banco del parque, leyendo un libro, atardecer»"
                disabled={generating}
                className="flex-1 resize-none rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/40 border transition-all duration-200 disabled:opacity-50 h-[52px] bg-white/10 border-white/15 focus:h-40 focus:bg-black/85 focus:border-white/40 focus:outline-none"
              />
              <button
                onClick={generating ? handleCancel : handleGenerate}
                title={generating ? 'Cancelar generación' : 'El personaje mantiene su identidad visual (usa su avatar como referencia); la escena solo cambia pose, acción y contexto'}
                className={`flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors flex-shrink-0 ${
                  generating ? 'bg-white/10 hover:bg-white/20 text-white' : 'bg-accent hover:bg-accent-hover text-white'
                }`}
              >
                {generating ? <X size={14} /> : <Sparkles size={14} />}
                {generating ? 'Cancelar' : 'Generar'}
              </button>
            </div>
            {genError && <p className="mt-1.5 text-[11px] text-red-400">{genError}</p>}
            {lastGeneratedPrompt && !genError && (
              <div className="mt-1.5">
                <button
                  onClick={() => setShowPrompt((v) => !v)}
                  className="flex items-center gap-1 text-[11px] text-white/50 hover:text-white/80 transition-colors"
                >
                  <ChevronDown size={12} className={`transition-transform ${showPrompt ? 'rotate-180' : ''}`} />
                  {showPrompt ? 'Ocultar prompt' : 'Ver prompt enviado a la IA de imagen'}
                </button>
                {showPrompt && (
                  <p className="mt-1 text-[11px] text-white/40 leading-relaxed">{lastGeneratedPrompt}</p>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Usage hint */
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-white/25 select-none pointer-events-none whitespace-nowrap">
          {hasGallery ? '←/→: galería · ' : ''}Rueda: zoom · Arrastrar: mover · Doble clic: restablecer
        </div>
      )}
    </div>
  );
}
