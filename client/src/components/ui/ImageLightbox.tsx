import { useEffect } from 'react';
import { X, Download, RotateCcw } from 'lucide-react';
import { useLightboxStore } from '../../stores/lightbox.store.ts';
import { useImagePanZoom } from '../../hooks/useImagePanZoom.ts';

export function ImageLightbox() {
  const { src, name, close } = useLightboxStore();
  const { wrapRef, imgRef, reset, onMouseDown } = useImagePanZoom(!!src, src);

  // Escape key
  useEffect(() => {
    if (!src) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [src, close]);

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
        <span className="text-sm font-medium text-white/90 truncate max-w-[50vw] pointer-events-auto">
          {name}
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

      {/* Usage hint */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-white/25 select-none pointer-events-none whitespace-nowrap">
        Rueda: zoom · Arrastrar: mover · Doble clic: restablecer
      </div>
    </div>
  );
}
