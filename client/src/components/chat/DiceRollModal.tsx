import { useEffect, useRef, useState } from 'react';
import { Modal } from '../ui/Modal.tsx';
import { useChatStore } from '../../stores/chat.store.ts';

// ─── d20 real, rasterizado a mano sobre <canvas> ─────────────────────────────
//
// Antes esto se intentó con divs en CSS 3D recortados con clip-path, y no podía
// funcionar: cada "cara" era un rectángulo recortado en su propio espacio 2D,
// así que los triángulos no coincidían con las aristas reales del icosaedro —
// no encajaban entre sí, quedaban huecos y solapes, y el conjunto se leía plano
// y sin lógica volumétrica.
//
// Aquí se hace la proyección 3D a mano: se rotan los 12 vértices reales, se
// descartan las caras traseras y se pintan los 10 triángulos frontales como
// polígonos de verdad. Al ser un sólido CONVEXO, las caras frontales nunca se
// tapan entre sí (verificado: siempre son exactamente 10 en cualquier
// orientación), así que el back-face culling basta y no hace falta ordenar por
// profundidad.

const PHI = (1 + Math.sqrt(5)) / 2;

/** Los 12 vértices canónicos del icosaedro regular: (0,±1,±φ), (±1,±φ,0), (±φ,0,±1).
 *  Centro geométrico en el origen; las 30 aristas miden todas lo mismo. */
const VERTS: Vec3[] = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
];

/** Topología del icosaedro: 20 caras triangulares, 30 aristas (cada una
 *  compartida por exactamente 2 caras), 12 vértices de grado 5. Todas las
 *  caras están enrolladas hacia fuera (normal · centroide > 0). */
const FACES: [number, number, number][] = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

type Vec3 = [number, number, number];
type Quat = [number, number, number, number]; // x, y, z, w

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vlen = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

const CENTROIDS: Vec3[] = FACES.map((f) => {
  const [a, b, c] = f.map((i) => VERTS[i]);
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
});
const FACE_NORMALS: Vec3[] = CENTROIDS.map(norm);

/** Numeración de dado real: las caras opuestas suman 21. Se calcula buscando
 *  para cada cara su antípoda (normal exactamente opuesta) y repartiendo k /
 *  21-k. Verificado: los 20 números aparecen una sola vez y todas las parejas
 *  opuestas suman 21. */
const FACE_NUMBER: number[] = (() => {
  const opposite = FACE_NORMALS.map((n) =>
    FACE_NORMALS.findIndex((m) => vlen(sub(m, [-n[0], -n[1], -n[2]])) < 1e-9),
  );
  const nums = new Array(20).fill(0);
  let next = 1;
  for (let i = 0; i < 20; i++) {
    if (nums[i]) continue;
    nums[i] = next;
    nums[opposite[i]] = 21 - next;
    next++;
  }
  return nums;
})();
/** Índice de cara que muestra un número dado (1-20) — para orientar la revelación. */
const FACE_FOR_NUMBER: number[] = (() => {
  const map = new Array(21).fill(0);
  FACE_NUMBER.forEach((n, i) => { map[n] = i; });
  return map;
})();

// ── Cuaterniones ────────────────────────────────────────────────────────────
function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const h = angle / 2, s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}
function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
function quatNormalize(q: Quat): Quat { const l = Math.hypot(...q) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; }
function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  const [ax, ay, az, aw] = a;
  let [bx, by, bz, bw] = b;
  let d = ax * bx + ay * by + az * bz + aw * bw;
  if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; d = -d; }
  if (d > 0.9995) return quatNormalize([ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, aw + (bw - aw) * t]);
  const th0 = Math.acos(d), th = th0 * t, s0 = Math.sin(th0);
  const w0 = Math.sin(th0 - th) / s0, w1 = Math.sin(th) / s0;
  return [ax * w0 + bx * w1, ay * w0 + by * w1, az * w0 + bz * w1, aw * w0 + bw * w1];
}
/** Cuaternión que lleva el vector unitario `a` hasta `b`. */
function quatFromTo(a: Vec3, b: Vec3): Quat {
  const d = dot(a, b);
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) {
    let axis = cross([1, 0, 0], a);
    if (vlen(axis) < 1e-6) axis = cross([0, 1, 0], a);
    return quatFromAxisAngle(norm(axis), Math.PI);
  }
  return quatFromAxisAngle(norm(cross(a, b)), Math.acos(Math.max(-1, Math.min(1, d))));
}
function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * v[0] + 2 * (xy - wz) * v[1] + 2 * (xz + wy) * v[2],
    2 * (xy + wz) * v[0] + (1 - 2 * (xx + zz)) * v[1] + 2 * (yz - wx) * v[2],
    2 * (xz - wy) * v[0] + 2 * (yz + wx) * v[1] + (1 - 2 * (xx + yy)) * v[2],
  ];
}

// ── Escena ──────────────────────────────────────────────────────────────────
const TRAY_W = 240;
const TRAY_H = 170;
const DIE_RADIUS = 44;               // radio de circunsfera en px
const SCALE = DIE_RADIUS / vlen(VERTS[0]);
const CAM_Z = 340;                   // distancia de cámara para la perspectiva
const BOUND_X = TRAY_W / 2 - DIE_RADIUS;
const BOUND_Y = TRAY_H / 2 - DIE_RADIUS;
const LIGHT = norm([-0.35, -0.7, 0.85]);

const ROLL_MS = 1300;
const BOUNCE_MS = 950;
const RAMP_MS = 150;
const BASE_SPEED = 5.2;
const RESTITUTION = 0.72;
const FRICTION = 0.985;

/** Inclinación de 3/4 que se aplica encima de "cara mirando a cámara": de
 *  frente a un eje de simetría la silueta sale simétrica y el sólido se lee
 *  plano; ladeado se aprecian las caras vecinas y el volumen. */
const THREE_QUARTER: Quat = quatMultiply(
  quatFromAxisAngle([0, 1, 0], 0.30),
  quatFromAxisAngle([1, 0, 0], -0.22),
);

/** Orientación que pone la cara `i` mirando a cámara CON SU NÚMERO DERECHO.
 *  El "arriba" de cada cara va del centroide a su primer vértice (por eso en
 *  un d20 cada número está girado distinto); aquí se compensa ese giro con una
 *  rotación en Z para que la cara revelada se lea sin torcer la cabeza. */
function faceToCameraUpright(i: number): Quat {
  const q1 = quatFromTo(FACE_NORMALS[i], [0, 0, 1]);
  const up = norm(sub(VERTS[FACES[i][0]], CENTROIDS[i]));
  const u = rotate(q1, up);
  const spin = quatFromAxisAngle([0, 0, 1], Math.PI / 2 - Math.atan2(u[1], u[0]));
  return quatMultiply(THREE_QUARTER, quatMultiply(spin, q1));
}

const REST_QUAT: Quat = faceToCameraUpright(0);

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** Dibuja el dado completo: rota los vértices, descarta caras traseras y pinta
 *  los triángulos frontales con sombreado plano + su número. */
function drawDie(ctx: CanvasRenderingContext2D, q: Quat, ox: number, oy: number, squash: number, accent: string) {
  ctx.clearRect(0, 0, TRAY_W, TRAY_H);
  const cx = TRAY_W / 2 + ox;
  const cy = TRAY_H / 2 + oy;

  // Vértices en espacio de cámara + su proyección en pantalla.
  const world = VERTS.map((v) => rotate(q, [v[0] * SCALE * squash, v[1] * SCALE * squash, v[2] * SCALE * squash]));
  const screen = world.map((p) => {
    const k = CAM_Z / (CAM_Z - p[2]);
    return [cx + p[0] * k, cy - p[1] * k];
  });

  for (let i = 0; i < 20; i++) {
    const n = rotate(q, FACE_NORMALS[i]);
    if (n[2] <= 0.001) continue;                     // cara trasera: no se ve

    const [ia, ib, ic] = FACES[i];
    const pa = screen[ia], pb = screen[ib], pc = screen[ic];

    // Sombreado plano: la cara entera con un único tono, según su normal.
    const lambert = Math.max(0, dot(n, LIGHT));
    const shade = 0.34 + 0.66 * lambert;
    ctx.beginPath();
    ctx.moveTo(pa[0], pa[1]);
    ctx.lineTo(pb[0], pb[1]);
    ctx.lineTo(pc[0], pc[1]);
    ctx.closePath();
    ctx.fillStyle = accent;
    ctx.globalAlpha = shade;
    ctx.fill();
    ctx.globalAlpha = 1;
    // Arista marcada: mantiene las 20 caras visualmente separadas.
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Número, en el centroide proyectado y orientado con la cara (gira con el
    // dado, como uno real). n[2] hace de medida de escorzo: en caras muy de
    // canto el número se encoge y se desvanece.
    const wc = rotate(q, [CENTROIDS[i][0] * SCALE * squash, CENTROIDS[i][1] * SCALE * squash, CENTROIDS[i][2] * SCALE * squash]);
    const kc = CAM_Z / (CAM_Z - wc[2]);
    const tx = cx + wc[0] * kc, ty = cy - wc[1] * kc;
    // "Arriba" de la cara: del centroide hacia su primer vértice.
    const up = Math.atan2(pa[1] - ty, pa[0] - tx) + Math.PI / 2;
    const size = 13 * n[2] * kc;
    if (size > 4) {
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(up);
      ctx.fillStyle = `rgba(255,255,255,${Math.min(1, n[2] * 1.6)})`;
      ctx.font = `600 ${size.toFixed(1)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = String(FACE_NUMBER[i]);
      ctx.fillText(label, 0, 0);
      // 6 y 9 se distinguen con un subrayado, como en un dado real.
      if (label === '6' || label === '9') {
        ctx.fillRect(-size * 0.28, size * 0.42, size * 0.56, Math.max(1, size * 0.08));
      }
      ctx.restore();
    }
  }
}

type Phase = 'idle' | 'rolling' | 'result';

export function DiceRollModal() {
  const pending = useChatStore((s) => s.pendingDiceRoll);
  const resolveDiceRoll = useChatStore((s) => s.resolveDiceRoll);
  const [phase, setPhase] = useState<Phase>('idle');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messageId = pending?.messageId;
  const natural = pending?.diceRoll.natural;

  // Prepara el canvas (nitidez en pantallas HiDPI) y pinta la pose de reposo.
  useEffect(() => {
    if (!messageId) return;
    setPhase('idle');
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = TRAY_W * dpr;
    canvas.height = TRAY_H * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const accent = getComputedStyle(canvas).getPropertyValue('--accent').trim() || '#8b5cf6';
    drawDie(ctx, REST_QUAT, 0, 0, 1, accent);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [messageId]);

  if (!pending) return null;
  const { diceRoll } = pending;

  const neededOnDie = Math.min(20, Math.max(1, diceRoll.cd - diceRoll.modifier));
  const modifierLabel =
    diceRoll.modifier === 0 ? '' : diceRoll.modifier > 0 ? `+${diceRoll.modifier}` : `${diceRoll.modifier}`;

  function handleRoll() {
    if (natural === undefined) return;
    setPhase('rolling');
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const accent = getComputedStyle(canvas!).getPropertyValue('--accent').trim() || '#8b5cf6';

    // Orientación final: la cara que lleva el número que salió, mirando a
    // cámara y con el número derecho.
    const qTarget = faceToCameraUpright(FACE_FOR_NUMBER[Math.max(1, Math.min(20, natural))]);

    const angle = Math.random() * Math.PI * 2;
    const dir = [Math.cos(angle), Math.sin(angle)];
    const pos = { x: 0, y: 0 };
    const vel = { x: 0, y: 0 };
    let q: Quat = REST_QUAT;
    let omega: Vec3 = [(Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14];
    let squash = 1;
    let settleFrom: { x: number; y: number; q: Quat } | null = null;
    const start = performance.now();
    let last = start;

    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      const f = dt / 16.6667;
      const elapsed = now - start;

      if (elapsed < BOUNCE_MS) {
        if (elapsed < RAMP_MS) {
          const ramp = easeOutCubic(elapsed / RAMP_MS);
          vel.x = dir[0] * BASE_SPEED * ramp;
          vel.y = dir[1] * BASE_SPEED * ramp;
        }
        pos.x += vel.x * f;
        pos.y += vel.y * f;

        let hit = false;
        if (pos.x > BOUND_X) { pos.x = BOUND_X; vel.x = -Math.abs(vel.x) * RESTITUTION; hit = true; }
        else if (pos.x < -BOUND_X) { pos.x = -BOUND_X; vel.x = Math.abs(vel.x) * RESTITUTION; hit = true; }
        if (pos.y > BOUND_Y) { pos.y = BOUND_Y; vel.y = -Math.abs(vel.y) * RESTITUTION; hit = true; }
        else if (pos.y < -BOUND_Y) { pos.y = -BOUND_Y; vel.y = Math.abs(vel.y) * RESTITUTION; hit = true; }

        const decay = Math.pow(FRICTION, f);
        vel.x *= decay; vel.y *= decay;
        omega = [omega[0] * decay, omega[1] * decay, omega[2] * decay];
        if (hit) {
          squash = 0.85;
          omega = [omega[0] + (Math.random() - 0.5) * 9, omega[1] + (Math.random() - 0.5) * 9, omega[2] + (Math.random() - 0.5) * 9];
        }
        squash += (1 - squash) * 0.28;

        const mag = vlen(omega);
        if (mag > 1e-4) q = quatNormalize(quatMultiply(quatFromAxisAngle(norm(omega), mag * (dt / 1000)), q));

        drawDie(ctx, q, pos.x, pos.y, squash, accent);
      } else {
        // Asentamiento: vuelve al centro y gira (slerp) hasta dejar arriba la
        // cara del resultado real.
        if (!settleFrom) settleFrom = { x: pos.x, y: pos.y, q };
        const t = Math.min(1, (elapsed - BOUNCE_MS) / (ROLL_MS - BOUNCE_MS));
        const e = easeOutCubic(t);
        drawDie(ctx, quatSlerp(settleFrom.q, qTarget, e), settleFrom.x * (1 - e), settleFrom.y * (1 - e), 1 + (1 - e) * 0.08, accent);
        if (t >= 1) return;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);

    timeoutRef.current = setTimeout(() => setPhase('result'), ROLL_MS);
  }

  const isCritSuccess = diceRoll.critical === 'success';
  const isCritFailure = diceRoll.critical === 'failure';
  const resultColor = isCritFailure ? 'text-red-400' : diceRoll.success ? 'text-emerald-400' : 'text-red-300';
  const resultLabel = isCritSuccess ? '¡Éxito crítico!' : isCritFailure ? '¡Fallo crítico!' : diceRoll.success ? 'Éxito' : 'Fallo';

  return (
    <Modal open onClose={() => {}} title="Tirada de dados" size="sm">
      <div className="flex flex-col items-center gap-4 py-2">
        <div className="text-center">
          <div className="text-sm font-medium text-text-primary">
            {diceRoll.who} · {diceRoll.attribute}
          </div>
          <div className="text-xs text-text-muted mt-1">{diceRoll.description}</div>
        </div>

        <div
          className="rounded-xl border border-border overflow-hidden"
          style={{ width: TRAY_W, height: TRAY_H, background: 'var(--surface-2)' }}
        >
          <canvas ref={canvasRef} style={{ width: TRAY_W, height: TRAY_H, display: 'block' }} />
        </div>

        {phase === 'result' ? (
          <>
            <div className="text-center -mt-1">
              <div className={`text-lg font-semibold ${resultColor}`}>{resultLabel}</div>
              <div className="text-xs text-text-muted mt-0.5 font-mono">
                {diceRoll.natural}{modifierLabel} = {diceRoll.total} vs CD {diceRoll.cd}
              </div>
            </div>
            <button
              onClick={resolveDiceRoll}
              className="px-8 py-2 rounded-xl border border-accent/50 text-accent hover:bg-accent/12 text-sm font-medium transition-colors"
            >
              Continuar
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleRoll}
              disabled={phase === 'rolling'}
              className="px-8 py-2.5 rounded-xl bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors disabled:opacity-60"
            >
              {phase === 'rolling' ? 'Tirando…' : 'Tirar'}
            </button>
            <p className="text-[11px] text-text-muted text-center leading-relaxed">
              Necesitas sacar un <span className="font-semibold text-text-secondary">{neededOnDie}</span> o más en el d20
              {modifierLabel && <> (con tu modificador de {modifierLabel})</>} para conseguirlo.
              <br />
              Un 20 natural siempre triunfa; un 1 natural siempre falla.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
