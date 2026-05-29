import { create } from 'zustand';
import { getAuthHeader } from '../api/client.ts';

// ─── Text cleaning ────────────────────────────────────────────────────────────

const MD_PATTERNS: [RegExp, string][] = [
  [/```[\s\S]*?```/g,         ''],   // fenced code
  [/`[^`]+`/g,                ''],   // inline code
  [/\*\*([^*]+)\*\*/g,        '$1'], // bold
  [/\*([^*]+)\*/g,            '$1'], // italic
  [/_([^_]+)_/g,              '$1'], // underscore italic
  [/^#{1,6}\s+/gm,            ''],   // headings
  [/\[([^\]]+)\]\([^)]+\)/g,  '$1'], // links
  [/^[-*+]\s+/gm,             ''],   // list markers
  [/^\d+\.\s+/gm,             ''],   // numbered lists
  [/---+/g,                   ''],   // horizontal rules
  // Acotaciones de escena al inicio de párrafo: (Aria frunce el ceño...)
  [/^\s*\([^)]{1,300}\)\s*/gm, ''],
];

function cleanForSpeech(text: string): string {
  let t = text;
  for (const [re, repl] of MD_PATTERNS) t = t.replace(re, repl);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Defaults TTS ─────────────────────────────────────────────────────────────

interface TtsConfig {
  voiceId:     string;
  speed:       number;
  temperature: number;
}

const DEFAULT_CONFIG: TtsConfig = {
  voiceId:     'es_daniela',
  speed:       1.0,
  temperature: 0.667,
};

// ─── Audio state (módulo-level, único) ───────────────────────────────────────

// AudioContext path — usado en iOS y navegadores modernos
let _audioCtx:    AudioContext | null = null;
let _audioSource: AudioBufferSourceNode | null = null;

// HTMLAudioElement fallback (edge cases)
let _audio:     HTMLAudioElement | null = null;
let _objectUrl: string | null = null;

function releaseAudio() {
  // AudioContext path
  try { _audioSource?.stop(); } catch { /* already stopped */ }
  _audioSource = null;
  try { _audioCtx?.close(); } catch { /* already closed */ }
  _audioCtx = null;

  // HTMLAudioElement path
  if (_audio) {
    _audio.pause();
    _audio.src    = '';
    _audio.onended = null;
    _audio.onerror = null;
    _audio = null;
  }
  if (_objectUrl) {
    URL.revokeObjectURL(_objectUrl);
    _objectUrl = null;
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface TtsStore {
  playingId: string | null;
  loadingId: string | null;
  lastError: string | null;

  speak: (messageId: string, text: string, config?: Partial<TtsConfig>) => Promise<void>;
  stop:  () => void;
}

export const useTtsStore = create<TtsStore>((set, get) => ({
  playingId: null,
  loadingId: null,
  lastError: null,

  stop() {
    releaseAudio();
    set({ playingId: null, loadingId: null });
  },

  async speak(messageId, text, config) {
    const { playingId, loadingId } = get();

    // Mismo mensaje → toggle off
    if (playingId === messageId || loadingId === messageId) {
      get().stop();
      return;
    }

    releaseAudio();
    set({ loadingId: messageId, playingId: null, lastError: null });

    // ── iOS fix: desbloquear AudioContext DENTRO del handler del gesto ─────────
    // iOS Safari pierde el contexto de gesto en cuanto hay una operación async
    // (como fetch). Crear y resumir el AudioContext aquí — ANTES del fetch —
    // lo "desbloquea" de forma persistente para el resto de la función.
    const AudioContextClass =
      window.AudioContext ?? (window as Record<string, unknown>).webkitAudioContext as typeof AudioContext | undefined;

    let audioCtx: AudioContext | null = null;
    if (AudioContextClass) {
      try {
        audioCtx = new AudioContextClass();
        await audioCtx.resume(); // desbloqueo iOS — debe llamarse antes de cualquier await de red
      } catch {
        audioCtx = null;
      }
    }

    const { voiceId, speed, temperature } = { ...DEFAULT_CONFIG, ...config };

    try {
      const resp = await fetch('/api/tts/synthesize', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify({
          text:        cleanForSpeech(text),
          voiceId,
          speed,
          temperature,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(String(err.error ?? 'Error de síntesis'));
      }

      if (audioCtx) {
        // ── Ruta AudioContext (iOS + Chrome + Firefox modernos) ───────────────
        // AudioContext.decodeAudioData no tiene restricciones de autoplay:
        // la reproducción ya está desbloqueada porque resumimos antes del fetch.
        const arrayBuffer = await resp.arrayBuffer();
        const decodedData = await audioCtx.decodeAudioData(arrayBuffer);

        const source = audioCtx.createBufferSource();
        source.buffer = decodedData;
        source.connect(audioCtx.destination);

        _audioCtx    = audioCtx;
        _audioSource = source;

        source.onended = () => {
          releaseAudio();
          set({ playingId: null });
        };

        set({ loadingId: null, playingId: messageId });
        source.start(0);

      } else {
        // ── Fallback: HTMLAudioElement ────────────────────────────────────────
        const blob = await resp.blob();
        _objectUrl = URL.createObjectURL(blob);
        _audio     = new Audio(_objectUrl);

        _audio.onended = () => { releaseAudio(); set({ playingId: null }); };
        _audio.onerror = () => { releaseAudio(); set({ playingId: null, lastError: 'Error al reproducir' }); };

        set({ loadingId: null, playingId: messageId });
        await _audio.play();
      }

    } catch (err) {
      // Limpiar el audioCtx si algo falla antes de asignarlo a _audioCtx
      if (audioCtx && audioCtx !== _audioCtx) {
        try { audioCtx.close(); } catch { /* noop */ }
      }
      releaseAudio();
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TTS]', msg);
      set({ loadingId: null, playingId: null, lastError: msg });
    }
  },
}));
