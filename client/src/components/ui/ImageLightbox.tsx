import { useEffect } from 'react';
import { X, Download } from 'lucide-react';
import { useLightboxStore } from '../../stores/lightbox.store.ts';

export function ImageLightbox() {
  const { src, name, close } = useLightboxStore();

  // Close on Escape
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
      style={{ background: 'rgba(0,0,0,0.88)' }}
      onClick={close}
    >
      {/* Toolbar */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center justify-between px-5 py-3"
        style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.6), transparent)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-sm font-medium text-white/90 truncate max-w-xs">{name}</span>
        <div className="flex items-center gap-2">
          <a
            href={src}
            download={`${name}.png`}
            title="Descargar imagen"
            className="p-2 rounded-lg hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <Download size={16} />
          </a>
          <button
            onClick={close}
            title="Cerrar (Esc)"
            className="p-2 rounded-lg hover:bg-white/10 text-white/70 hover:text-white transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Image */}
      <img
        src={src}
        alt={name}
        className="max-w-[90vw] max-h-[90vh] rounded-xl object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ userSelect: 'none' }}
      />
    </div>
  );
}
