import React, { useState, useCallback } from 'react';
import Cropper from 'react-easy-crop';
import type { Area } from 'react-easy-crop';
import { X, ZoomIn, ZoomOut, Crop } from 'lucide-react';
import { getCroppedImg } from '../../utils/cropImage.ts';

interface AvatarCropModalProps {
  /** URL/path of the source image to crop */
  imageSrc: string;
  onConfirm: (croppedBlob: Blob) => void | Promise<void>;
  onClose: () => void;
}

export function AvatarCropModal({ imageSrc, onConfirm, onClose }: AvatarCropModalProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [saving, setSaving] = useState(false);

  const onCropComplete = useCallback((_: Area, pixels: Area) => {
    setCroppedAreaPixels(pixels);
  }, []);

  async function handleConfirm() {
    if (!croppedAreaPixels) return;
    setSaving(true);
    try {
      const blob = await getCroppedImg(imageSrc, croppedAreaPixels);
      await onConfirm(blob);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border flex flex-col animate-slide-up overflow-hidden"
        style={{ background: 'var(--surface-1)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Crop size={15} className="text-accent" />
            <div>
              <p className="font-semibold text-sm">Recortar avatar</p>
              <p className="text-[10px] text-text-muted mt-0.5">
                Arrastra para mover · Rueda del ratón o deslizador para zoom
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Cropper area */}
        <div className="relative w-full" style={{ height: '340px', background: '#111' }}>
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape="round"
            showGrid={false}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
            style={{
              containerStyle: { borderRadius: 0 },
              cropAreaStyle: { border: '2px solid var(--accent)' },
            }}
          />
        </div>

        {/* Zoom slider */}
        <div className="flex items-center gap-3 px-5 py-3 border-t border-border flex-shrink-0">
          <button
            onClick={() => setZoom((z) => Math.max(1, z - 0.1))}
            className="p-1 rounded text-text-muted hover:text-text-primary transition-colors"
          >
            <ZoomOut size={14} />
          </button>
          <input
            type="range"
            min={1}
            max={3}
            step={0.02}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1 accent-violet-600"
          />
          <button
            onClick={() => setZoom((z) => Math.min(3, z + 0.1))}
            className="p-1 rounded text-text-muted hover:text-text-primary transition-colors"
          >
            <ZoomIn size={14} />
          </button>
          <span className="text-[10px] text-text-muted tabular-nums w-8 text-right">
            {zoom.toFixed(1)}×
          </span>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-text-muted hover:text-text-primary border border-border hover:border-accent/40 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleConfirm}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors"
          >
            <Crop size={13} />
            {saving ? 'Guardando…' : 'Usar este recorte'}
          </button>
        </div>
      </div>
    </div>
  );
}
