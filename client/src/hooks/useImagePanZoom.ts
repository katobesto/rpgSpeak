import { useRef, useEffect, useCallback } from 'react';

/**
 * Zoom + pan interaction for a fullscreen image viewer.
 * Port of the bzComfy vanilla-JS viewer to React hooks.
 *
 * Usage:
 *   const { wrapRef, imgRef, reset, onMouseDown } = useImagePanZoom(isOpen, imageUrl);
 *   <div ref={wrapRef} onMouseDown={onMouseDown} onDoubleClick={reset} style={{ touchAction:'none' }}>
 *     <img ref={imgRef} ... />
 *   </div>
 *
 * Supports:
 *   - Mouse wheel zoom (toward cursor)
 *   - MacBook trackpad pinch (ctrlKey=true, high sensitivity)
 *   - Left-click drag pan
 *   - Touch pinch-zoom + single-finger pan (while zoomed)
 *   - Double-click / double-tap to reset
 */
export function useImagePanZoom(active: boolean, resetKey?: unknown) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef  = useRef<HTMLImageElement>(null);

  // Mutable state via refs — no re-renders during interaction
  const z   = useRef(1);
  const px  = useRef(0);
  const py  = useRef(0);
  const drag = useRef(false);
  const lm   = useRef({ x: 0, y: 0 });      // last mouse/touch position
  const ltd  = useRef<number | null>(null);  // last pinch distance
  const tst  = useRef(0);                    // touchstart time
  const ltt  = useRef(0);                    // last tap time (double-tap detection)

  function apply() {
    const img = imgRef.current;
    if (!img) return;
    img.style.transform =
      z.current === 1 && px.current === 0 && py.current === 0
        ? ''
        : `translate(${px.current}px, ${py.current}px) scale(${z.current})`;
  }

  function updateCursor() {
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.style.cursor = drag.current ? 'grabbing' : z.current > 1.01 ? 'grab' : '';
  }

  // Zoom toward a screen point (clientX/Y).
  // Formula: keep the image point under the cursor fixed in screen space.
  function zoomAt(cx: number, cy: number, factor: number) {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r  = wrap.getBoundingClientRect();
    const mx = cx - (r.left + r.width  / 2);
    const my = cy - (r.top  + r.height / 2);
    const nz = Math.min(Math.max(z.current * factor, 0.2), 12);
    const rt = nz / z.current;
    px.current = mx * (1 - rt) + px.current * rt;
    py.current = my * (1 - rt) + py.current * rt;
    z.current  = nz;
    apply();
    updateCursor();
  }

  const reset = useCallback(() => {
    z.current = 1; px.current = 0; py.current = 0;
    apply();
    if (wrapRef.current) wrapRef.current.style.cursor = '';
  }, []);

  // Reset when the viewer opens or the displayed image changes
  useEffect(() => {
    if (active) reset();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, resetKey]);

  // Wheel — non-passive so we can preventDefault
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !active) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      // macOS trackpad pinch fires with ctrlKey=true and small deltaY (~1–10).
      // Regular mouse wheel has large deltaY (~100 per notch).
      const factor = e.ctrlKey
        ? Math.pow(0.975, e.deltaY)  // trackpad pinch — higher sensitivity
        : Math.pow(0.999, e.deltaY); // mouse wheel — standard sensitivity
      zoomAt(e.clientX, e.clientY, factor);
    };
    wrap.addEventListener('wheel', handler, { passive: false });
    return () => wrap.removeEventListener('wheel', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Mouse drag — attached to window so dragging past the edge still works
  useEffect(() => {
    if (!active) return;
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      px.current += e.clientX - lm.current.x;
      py.current += e.clientY - lm.current.y;
      lm.current = { x: e.clientX, y: e.clientY };
      apply();
    };
    const onUp = () => {
      if (drag.current) { drag.current = false; updateCursor(); }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Touch — non-passive, handles pinch-zoom and single-finger pan
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !active) return;

    function pinchDist(t: TouchList) {
      const dx = t[0].clientX - t[1].clientX;
      const dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      tst.current = Date.now();
      if (e.touches.length === 2) {
        ltd.current  = pinchDist(e.touches);
        drag.current = false;
      } else {
        lm.current   = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        drag.current = z.current > 1.01;
      }
    };

    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2 && ltd.current !== null) {
        const nd = pinchDist(e.touches);
        zoomAt(
          (e.touches[0].clientX + e.touches[1].clientX) / 2,
          (e.touches[0].clientY + e.touches[1].clientY) / 2,
          nd / ltd.current,
        );
        ltd.current  = nd;
        drag.current = false;
      } else if (e.touches.length === 1 && drag.current) {
        px.current += e.touches[0].clientX - lm.current.x;
        py.current += e.touches[0].clientY - lm.current.y;
        lm.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        apply();
      }
    };

    const onEnd = (e: TouchEvent) => {
      ltd.current = null;
      if (e.touches.length === 0) drag.current = false;
      // Double-tap detection
      if (e.changedTouches.length === 1 && Date.now() - tst.current < 250) {
        const now = Date.now();
        if (now - ltt.current < 350) { reset(); ltt.current = 0; }
        else ltt.current = now;
      }
    };

    wrap.addEventListener('touchstart', onStart, { passive: false });
    wrap.addEventListener('touchmove',  onMove,  { passive: false });
    wrap.addEventListener('touchend',   onEnd,   { passive: false });
    return () => {
      wrap.removeEventListener('touchstart', onStart);
      wrap.removeEventListener('touchmove',  onMove);
      wrap.removeEventListener('touchend',   onEnd);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reset]);

  // Handler to attach to the wrapper's onMouseDown
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    drag.current = true;
    lm.current   = { x: e.clientX, y: e.clientY };
    updateCursor();
    e.preventDefault();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { wrapRef, imgRef, reset, onMouseDown };
}
