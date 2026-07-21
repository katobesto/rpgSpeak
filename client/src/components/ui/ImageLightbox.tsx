import { useEffect } from 'react';
import { X, Download, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react';
import { useLightboxStore } from '../../stores/lightbox.store.ts';
import { useImagePanZoom } from '../../hooks/useImagePanZoom.ts';
import { useBackHandler } from '../../hooks/useBackHandler.ts';

export function ImageLightbox() {
  const { src, name, gallery, index, close, next, prev } = useLightboxStore();
  const { wrapRef, imgRef, reset, onMouseDown } = useImagePanZoom(!!src, src);
  const hasGallery = gallery.length > 1;

  // Escape to close, ←/→ to navigate the gallery, mobile swipe-back
  useEffect(() => {
    if (!src) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (hasGallery && e.key === 'ArrowRight') next();
      else if (hasGallery && e.key === 'ArrowLeft') prev();
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

      {/* Usage hint */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-white/25 select-none pointer-events-none whitespace-nowrap">
        {hasGallery ? '←/→: galería · ' : ''}Rueda: zoom · Arrastrar: mover · Doble clic: restablecer
      </div>
    </div>
  );
}
