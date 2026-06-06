import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, MessageSquare, ChevronLeft, ChevronRight, Images, Download, RotateCcw } from 'lucide-react';
import type { Message } from '@rpgspeak/shared';
import { useImagePanZoom } from '../../hooks/useImagePanZoom.ts';

interface GalleryImage {
  messageId:  string;
  messageIdx: number;
  imageUrl:   string;
}

interface ImageGalleryModalProps {
  messages:  Message[];
  onClose:   () => void;
  onJumpTo:  (messageIndex: number, messageId: string) => void;
}

// ─── GalleryLightbox ─────────────────────────────────────────────────────────
// Separate component so the hook mounts/unmounts cleanly per image.
// Mounted with key={index} so navigating always resets the zoom state.

interface GalleryLightboxProps {
  image:     GalleryImage;
  index:     number;
  total:     number;
  onClose:   () => void;
  onPrev:    () => void;
  onNext:    () => void;
  onJumpTo:  () => void;
}

function GalleryLightbox({ image, index, total, onClose, onPrev, onNext, onJumpTo }: GalleryLightboxProps) {
  const { wrapRef, imgRef, reset, onMouseDown } = useImagePanZoom(true);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.94)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Toolbar */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center justify-between px-5 py-3 z-10 pointer-events-none"
        style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.65), transparent)' }}
      >
        <span className="text-sm font-medium text-white/80 tabular-nums pointer-events-auto select-none">
          {index + 1} / {total}
        </span>
        <div className="flex items-center gap-1 pointer-events-auto">
          <button
            onClick={reset}
            title="Restablecer zoom (doble clic)"
            className="p-2 rounded-lg hover:bg-white/12 text-white/60 hover:text-white transition-colors"
          >
            <RotateCcw size={15} />
          </button>
          <a
            href={image.imageUrl}
            download={`imagen-${index + 1}.png`}
            title="Descargar"
            className="p-2 rounded-lg hover:bg-white/12 text-white/60 hover:text-white transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <Download size={15} />
          </a>
          <button
            onClick={onClose}
            title="Cerrar (Esc)"
            className="p-2 rounded-lg hover:bg-white/12 text-white/60 hover:text-white transition-colors"
          >
            <X size={18} />
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
          src={image.imageUrl}
          alt={`Imagen ${index + 1}`}
          className="max-w-[90vw] max-h-[90vh] rounded-xl shadow-2xl object-contain"
          style={{ userSelect: 'none', transformOrigin: 'center center' }}
          draggable={false}
        />
      </div>

      {/* Prev */}
      {total > 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); onPrev(); }}
          className="absolute left-4 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
        >
          <ChevronLeft size={22} />
        </button>
      )}

      {/* Next */}
      {total > 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); onNext(); }}
          className="absolute right-4 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
        >
          <ChevronRight size={22} />
        </button>
      )}

      {/* Bottom bar */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2.5 rounded-full bg-black/60 backdrop-blur-sm border border-white/10 z-10">
        <span className="text-[11px] text-white/40 select-none whitespace-nowrap">
          Rueda: zoom · Arrastrar: mover · Doble clic: restablecer
        </span>
        <div className="w-px h-3 bg-white/20" />
        <button
          onClick={onJumpTo}
          className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 font-medium transition-colors whitespace-nowrap"
        >
          <MessageSquare size={12} />
          Ir al mensaje
        </button>
      </div>
    </div>
  );
}

// ─── ImageGalleryModal ────────────────────────────────────────────────────────

export function ImageGalleryModal({ messages, onClose, onJumpTo }: ImageGalleryModalProps) {
  const images: GalleryImage[] = messages.flatMap((m, idx) => {
    const meta = m.metadata ?? {};
    if (Array.isArray((meta as any).sceneImages)) {
      return ((meta as any).sceneImages as Array<{ url: string; pending?: boolean }>)
        .filter((i) => !i.pending && !!i.url)
        .map((i) => ({ messageId: m.id, messageIdx: idx, imageUrl: i.url }));
    }
    const legacyUrl = (meta as any).sceneImageUrl as string | undefined;
    if (legacyUrl) return [{ messageId: m.id, messageIdx: idx, imageUrl: legacyUrl }];
    return [];
  });

  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  // Keyboard navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (lightboxIdx !== null) setLightboxIdx(null);
        else onClose();
      }
      if (lightboxIdx !== null) {
        if (e.key === 'ArrowRight') setLightboxIdx((i) => (i! + 1) % images.length);
        if (e.key === 'ArrowLeft')  setLightboxIdx((i) => (i! - 1 + images.length) % images.length);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxIdx, images.length, onClose]);

  const currentImage = lightboxIdx !== null ? images[lightboxIdx] : null;

  const modal = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={(e) => { if (e.target === e.currentTarget) { if (lightboxIdx !== null) setLightboxIdx(null); else onClose(); } }}
    >
      <div
        className="relative w-full max-w-4xl rounded-2xl border border-border flex flex-col shadow-2xl animate-slide-up"
        style={{ background: 'var(--surface-1)', maxHeight: '90vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <Images size={15} className="text-accent" />
            <span className="font-semibold text-sm">Galería de imágenes</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/20 tabular-nums">
              {images.length} {images.length === 1 ? 'imagen' : 'imágenes'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-5">
          {images.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <Images size={36} className="text-text-muted opacity-30" />
              <p className="text-sm text-text-muted">No hay imágenes en esta conversación todavía.</p>
              <p className="text-xs text-text-muted opacity-70">
                Genera o sube imágenes desde los mensajes del chat.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {images.map((img, i) => (
                <div
                  key={`${img.messageId}_${i}`}
                  className="group relative aspect-square rounded-xl overflow-hidden border border-border cursor-pointer hover:border-accent/50 transition-all"
                  onClick={() => setLightboxIdx(i)}
                >
                  <img
                    src={img.imageUrl}
                    alt={`Imagen ${i + 1}`}
                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                    <ZoomIn size={22} className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-lg" />
                  </div>
                  <span className="absolute top-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-black/60 text-white tabular-nums">
                    {i + 1}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox — key resets zoom state on navigation */}
      {currentImage && (
        <GalleryLightbox
          key={lightboxIdx}
          image={currentImage}
          index={lightboxIdx!}
          total={images.length}
          onClose={() => setLightboxIdx(null)}
          onPrev={() => setLightboxIdx((i) => (i! - 1 + images.length) % images.length)}
          onNext={() => setLightboxIdx((i) => (i! + 1) % images.length)}
          onJumpTo={() => onJumpTo(currentImage.messageIdx, currentImage.messageId)}
        />
      )}
    </div>
  );

  return createPortal(modal, document.body);
}
