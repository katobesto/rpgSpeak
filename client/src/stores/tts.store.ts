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
  // Solo borra paréntesis al inicio de línea, no en medio de frases normales.
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

// ─── Audio (módulo-level, único) ──────────────────────────────────────────────

let _audio:     HTMLAudioElement | null = null;
let _objectUrl: string | null = null;

function releaseAudio() {
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

      const blob = await resp.blob();
      _objectUrl = URL.createObjectURL(blob);
      _audio     = new Audio(_objectUrl);

      _audio.onended = () => { releaseAudio(); set({ playingId: null }); };
      _audio.onerror = () => { releaseAudio(); set({ playingId: null, lastError: 'Error al reproducir' }); };

      set({ loadingId: null, playingId: messageId });
      await _audio.play();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TTS]', msg);
      set({ loadingId: null, playingId: null, lastError: msg });
    }
  },
}));
