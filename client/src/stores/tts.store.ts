import { create } from 'zustand';
import { getAuthHeader } from '../api/client.ts';

// ─── Text cleaning ────────────────────────────────────────────────────────────

function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*\([^)]{1,300}\)\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Defaults ────────────────────────────────────────────────────────────────

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

// ─── Audio state ──────────────────────────────────────────────────────────────

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
  // Reset MediaSession state
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = 'none'; } catch {}
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface TtsStore {
  playingId: string | null;
  loadingId: string | null;
  lastError: string | null;
  duration:  number;   // segundos totales del audio en reproducción
  currentTime: number; // posición actual en segundos

  speak: (messageId: string, text: string, config?: Partial<TtsConfig>) => Promise<void>;
  stop:  () => void;
}

export const useTtsStore = create<TtsStore>((set, get) => ({
  playingId:   null,
  loadingId:   null,
  lastError:   null,
  duration:    0,
  currentTime: 0,

  stop() {
    releaseAudio();
    set({ playingId: null, loadingId: null, duration: 0, currentTime: 0 });
  },

  async speak(messageId, text, config) {
    const { playingId, loadingId } = get();

    // Toggle off si ya está sonando o cargando este mensaje
    if (playingId === messageId || loadingId === messageId) {
      get().stop();
      return;
    }

    releaseAudio();
    set({ loadingId: messageId, playingId: null, lastError: null, duration: 0, currentTime: 0 });

    // ── iOS unlock — DEBE ir antes del primer await ────────────────────────
    // AudioContext.resume() dentro del gesto desbloquea el motor de audio.
    // HTMLAudioElement.play() también se beneficia de esto en iOS moderno.
    const AudioCtxClass =
      window.AudioContext ??
      (window as Record<string, unknown>).webkitAudioContext as typeof AudioContext | undefined;
    if (AudioCtxClass) {
      try {
        const ctx = new AudioCtxClass();
        await ctx.resume();
        ctx.close(); // solo lo usamos para desbloquear, no para reproducir
      } catch { /* no crítico */ }
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

      // Crear blob con el Content-Type correcto (WAV para Piper, MP3 para Edge TTS)
      const contentType = resp.headers.get('content-type') ?? 'audio/wav';
      const blob        = new Blob([await resp.arrayBuffer()], { type: contentType });
      const url         = URL.createObjectURL(blob);

      // ── HTMLAudioElement para reproducción ────────────────────────────────
      // A diferencia de AudioContext, HTMLAudioElement continúa reproduciéndose
      // cuando el dispositivo se bloquea o la pantalla se apaga (iOS).
      const audio       = new Audio(url);
      _audio            = audio;
      _objectUrl        = url;

      // Progreso en tiempo real
      audio.ontimeupdate = () => set({ currentTime: audio.currentTime });
      audio.onloadedmetadata = () => set({ duration: audio.duration });

      audio.onended = () => {
        releaseAudio();
        set({ playingId: null, duration: 0, currentTime: 0 });
      };
      audio.onerror = () => {
        releaseAudio();
        set({ playingId: null, lastError: 'Error al reproducir' });
      };

      // ── MediaSession API ──────────────────────────────────────────────────
      // Informa al SO que hay media reproduciéndose: impide que iOS pause el
      // audio al bloquear la pantalla y muestra controles en la pantalla de bloqueo.
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title:  'rpgSpeak',
          artist: 'Narración',
          album:  '',
        });
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.setActionHandler('play',  () => {
          audio.play().catch(() => {});
          set({ playingId: messageId });
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          audio.pause();
          set({ playingId: null });
          navigator.mediaSession.playbackState = 'paused';
        });
        navigator.mediaSession.setActionHandler('stop',  () => get().stop());
      }

      set({ loadingId: null, playingId: messageId });
      await audio.play();

    } catch (err) {
      releaseAudio();
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TTS]', msg);
      set({ loadingId: null, playingId: null, lastError: msg });
    }
  },
}));
