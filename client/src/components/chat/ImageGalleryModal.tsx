import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, MessageSquare, ChevronLeft, ChevronRight, Images } from 'lucide-react';
import type { Message } from '@rpgspeak/shared';

interface GalleryImage {
  messageId:  string;
  messageIdx: number;
  imageUrl:   string;
}

interface ImageGalleryModalProps {
  messages:     Message[];
  onClose:      () => void;
  onJumpTo:     (messageIndex: number, messageId: string) => void;
}

export function ImageGalleryModal({ messages, onClose, onJumpTo }: ImageGalleryModalProps) {
  // Collect all messages that have a scene image
  const images: GalleryImage[] = messages
    .map((m, idx) => ({
      messageId:  m.id,
      messageIdx: idx,
      imageUrl:   (m.metadata?.sceneImageUrl as string | undefined) ?? '',
    }))
    .filter((g) => !!g.imageUrl);

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
        {/* ── Header ── */}
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

        {/* ── Body ── */}
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
                  key={img.messageId}
                  className="group relative aspect-square rounded-xl overflow-hidden border border-border cursor-pointer hover:border-accent/50 transition-all"
                  onClick={() => setLightboxIdx(i)}
                >
                  <img
                    src={img.imageUrl}
                    alt={`Imagen ${i + 1}`}
                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  {/* Hover overlay */}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                    <ZoomIn
                      size={22}
                      className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-lg"
                    />
                  </div>
                  {/* Image number badge */}
                  <span className="absolute top-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-black/60 text-white tabular-nums">
                    {i + 1}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Lightbox ── */}
      {currentImage && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.92)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setLightboxIdx(null); }}
        >
          {/* Close lightbox */}
          <button
            onClick={() => setLightboxIdx(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
          >
            <X size={18} />
          </button>

          {/* Prev */}
          {images.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); setLightboxIdx((i) => (i! - 1 + images.length) % images.length); }}
              className="absolute left-4 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
            >
              <ChevronLeft size={22} />
            </button>
          )}

          {/* Image */}
          <img
            src={currentImage.imageUrl}
            alt={`Imagen ${lightboxIdx! + 1}`}
            className="max-w-[88vw] max-h-[80vh] rounded-xl shadow-2xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />

          {/* Next */}
          {images.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); setLightboxIdx((i) => (i! + 1) % images.length); }}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
            >
              <ChevronRight size={22} />
            </button>
          )}

          {/* Bottom bar — counter + jump button */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2.5 rounded-full bg-black/60 backdrop-blur-sm border border-white/10">
            <span className="text-xs text-white/70 tabular-nums">
              {lightboxIdx! + 1} / {images.length}
            </span>
            <div className="w-px h-3 bg-white/20" />
            <button
              onClick={() => { onJumpTo(currentImage.messageIdx, currentImage.messageId); }}
              className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 font-medium transition-colors"
            >
              <MessageSquare size={12} />
              Ir al mensaje
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(modal, document.body);
}
