import { create } from 'zustand';
import { getAuthHeader } from '../api/client.ts';
import type { TtsTextReplacement } from '@rpgspeak/shared';

// ─── Text cleaning ────────────────────────────────────────────────────────────

function applyReplacements(text: string, replacements: TtsTextReplacement[]): string {
  let result = text;
  for (const { search, replace } of replacements) {
    if (!search.trim()) continue;
    try {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'gi'), replace);
    } catch { /* regex inválida — ignorar */ }
  }
  return result;
}

function cleanForSpeech(text: string, replacements: TtsTextReplacement[] = []): string {
  let t = replacements.length > 0 ? applyReplacements(text, replacements) : text;
  return t
    .replace(/\*\*([^*:\n]{1,50}):\*\*\s*\n?/g, '$1 dice, ')
    .replace(/^([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{0,29}(?:\s+[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{0,29}){0,3}):\s+/gm, '$1 dice, ')
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
  voiceId:      string;
  speed:        number;
  temperature:  number;
  replacements: TtsTextReplacement[];
}

const DEFAULT_CONFIG: TtsConfig = {
  voiceId:      'edge_elvira',
  speed:        1.0,
  temperature:  0.667,
  replacements: [],
};

// ─── Audio cache ──────────────────────────────────────────────────────────────

const MAX_CACHE = 30;
const _audioCache = new Map<string, Blob>();

function audioCacheKey(messageId: string, voiceId: string, speed: number): string {
  return `${messageId}:${voiceId}:${speed.toFixed(1)}`;
}

function cacheSet(key: string, blob: Blob): void {
  if (_audioCache.size >= MAX_CACHE) {
    const oldest = _audioCache.keys().next().value;
    if (oldest) _audioCache.delete(oldest);
  }
  _audioCache.set(key, blob);
}

// ─── Audio state (módulo-level) ───────────────────────────────────────────────

let _audio:     HTMLAudioElement | null = null;
let _objectUrl: string | null = null;
let _pausedMsgId: string | null = null; // qué mensaje está pausado (no liberado)

function releaseAudio() {
  if (_audio) {
    _audio.onpause   = null;
    _audio.onended   = null;
    _audio.onerror   = null;
    _audio.ontimeupdate = null;
    _audio.onloadedmetadata = null;
    _audio.pause();
    _audio.src = '';
    _audio = null;
  }
  if (_objectUrl) {
    URL.revokeObjectURL(_objectUrl);
    _objectUrl = null;
  }
  _pausedMsgId = null;
  try {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  } catch {}
}

function msUpdate(audio: HTMLAudioElement) {
  try {
    if ('mediaSession' in navigator && isFinite(audio.duration) && audio.duration > 0) {
      navigator.mediaSession.setPositionState({
        duration:     audio.duration,
        playbackRate: audio.playbackRate,
        position:     Math.min(audio.currentTime, audio.duration),
      });
    }
  } catch {}
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface TtsStore {
  playingId:   string | null;
  pausedId:    string | null; // mensaje pausado (no liberado, se puede reanudar)
  loadingId:   string | null;
  lastError:   string | null;
  duration:    number;
  currentTime: number;
  cachedKeys:  ReadonlySet<string>;

  speak:           (messageId: string, text: string, config?: Partial<TtsConfig>) => Promise<void>;
  pause:           () => void;
  resume:          () => void;
  stop:            () => void;
  seek:            (time: number) => void;
  isCached:        (messageId: string, config?: Partial<TtsConfig>) => boolean;
  shareOrDownload: (messageId: string, config?: Partial<TtsConfig>) => Promise<void>;
}

export const useTtsStore = create<TtsStore>((set, get) => ({
  playingId:   null,
  pausedId:    null,
  loadingId:   null,
  lastError:   null,
  duration:    0,
  currentTime: 0,
  cachedKeys:  new Set<string>(),

  // ── Pausa sin liberar el audio ────────────────────────────────────────────
  pause() {
    const { playingId } = get();
    if (_audio && playingId) {
      _audio.pause(); // dispara onpause → actualiza estado
    }
  },

  // ── Reanuda desde donde se quedó ──────────────────────────────────────────
  resume() {
    const { pausedId } = get();
    if (_audio && pausedId) {
      _audio.play().catch(() => {});
      set({ playingId: pausedId, pausedId: null });
      try {
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      } catch {}
    }
  },

  // ── Stop completo — libera el audio ──────────────────────────────────────
  stop() {
    releaseAudio();
    set({ playingId: null, pausedId: null, loadingId: null, duration: 0, currentTime: 0 });
  },

  seek(time) {
    if (_audio) {
      _audio.currentTime = Math.max(0, Math.min(time, _audio.duration || 0));
      msUpdate(_audio);
    }
  },

  isCached(messageId, config) {
    const { voiceId, speed } = { ...DEFAULT_CONFIG, ...config };
    return _audioCache.has(audioCacheKey(messageId, voiceId, speed));
  },

  // ── Descarga o comparte el audio cacheado ─────────────────────────────────
  async shareOrDownload(messageId, config) {
    const { voiceId, speed } = { ...DEFAULT_CONFIG, ...config };
    const cKey = audioCacheKey(messageId, voiceId, speed);
    const blob = _audioCache.get(cKey);
    if (!blob) return;

    const ext      = blob.type.includes('mpeg') ? 'mp3' : 'wav';
    const filename = `rpgspeak-${messageId.slice(0, 8)}.${ext}`;
    const file     = new File([blob], filename, { type: blob.type });

    // Web Share API con archivos (iOS Safari 14+, Android Chrome)
    if (
      navigator.canShare &&
      navigator.canShare({ files: [file] })
    ) {
      try {
        await navigator.share({
          files: [file],
          title: 'rpgSpeak — Narración',
        });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return; // usuario canceló
        // Si falla el share, caer al download
      }
    }

    // Fallback: descarga directa
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },

  // ── Síntesis y reproducción ───────────────────────────────────────────────
  async speak(messageId, text, config) {
    const { playingId, loadingId, pausedId } = get();

    // Si este mensaje está PAUSADO → reanudar (no re-sintetizar)
    if (pausedId === messageId) {
      get().resume();
      return;
    }

    // Si este mensaje está REPRODUCIENDO o CARGANDO → pausar
    if (playingId === messageId) {
      get().pause();
      return;
    }
    if (loadingId === messageId) {
      get().stop();
      return;
    }

    // Liberar cualquier audio anterior
    releaseAudio();
    set({ loadingId: messageId, playingId: null, pausedId: null, lastError: null, duration: 0, currentTime: 0 });

    // ── iOS unlock (antes del primer await) ──────────────────────────────
    const AudioCtxClass =
      window.AudioContext ??
      (window as Record<string, unknown>).webkitAudioContext as typeof AudioContext | undefined;
    if (AudioCtxClass) {
      try {
        const ctx = new AudioCtxClass();
        await ctx.resume();
        ctx.close();
      } catch { /* no crítico */ }
    }

    const { voiceId, speed, temperature, replacements } = { ...DEFAULT_CONFIG, ...config };
    const cKey = audioCacheKey(messageId, voiceId, speed);

    try {
      let blob: Blob;

      if (_audioCache.has(cKey)) {
        blob = _audioCache.get(cKey)!;
      } else {
        const resp = await fetch('/api/tts/synthesize', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
          body: JSON.stringify({
            text:        cleanForSpeech(text, replacements),
            voiceId,
            speed,
            temperature,
          }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({})) as Record<string, unknown>;
          throw new Error(String(err.error ?? 'Error de síntesis'));
        }

        const contentType = resp.headers.get('content-type') ?? 'audio/wav';
        blob = new Blob([await resp.arrayBuffer()], { type: contentType });
        cacheSet(cKey, blob);
        set((s) => ({ cachedKeys: new Set([...s.cachedKeys, cKey]) }));
      }

      const url   = URL.createObjectURL(blob);
      const audio = new Audio(url);
      _audio      = audio;
      _objectUrl  = url;

      // ── Eventos del elemento de audio ──────────────────────────────────
      audio.onloadedmetadata = () => {
        set({ duration: audio.duration });
        msUpdate(audio);
      };

      audio.ontimeupdate = () => {
        set({ currentTime: audio.currentTime });
        msUpdate(audio);
      };

      // PAUSA (AirPods sacados, llamada telefónica, etc.) — NO liberar
      audio.onpause = () => {
        if (!audio.ended) {
          _pausedMsgId = messageId;
          set({ playingId: null, pausedId: messageId });
          try {
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
          } catch {}
        }
      };

      // FIN de pista — liberar
      audio.onended = () => {
        releaseAudio();
        set({ playingId: null, pausedId: null, duration: 0, currentTime: 0 });
      };

      audio.onerror = () => {
        releaseAudio();
        set({ playingId: null, pausedId: null, lastError: 'Error al reproducir' });
      };

      // ── MediaSession API ────────────────────────────────────────────────
      // Muestra controles en pantalla de bloqueo y permite control con AirPods.
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title:   'rpgSpeak',
          artist:  'Narración',
          album:   '',
          artwork: [
            { src: '/favicon.svg', sizes: '512x512', type: 'image/svg+xml' },
          ],
        });
        navigator.mediaSession.playbackState = 'playing';

        // Botón play de AirPods / pantalla de bloqueo
        navigator.mediaSession.setActionHandler('play', () => {
          if (_audio?.paused && _pausedMsgId) {
            get().resume();
          }
        });
        // Botón pause de AirPods / pantalla de bloqueo
        navigator.mediaSession.setActionHandler('pause', () => {
          get().pause();
        });
        // Stop (swipe en pantalla de bloqueo)
        navigator.mediaSession.setActionHandler('stop', () => {
          get().stop();
        });
        // Seek (barra de progreso en pantalla de bloqueo, iOS 16+)
        navigator.mediaSession.setActionHandler('seekto', (details) => {
          if (details.seekTime !== undefined) get().seek(details.seekTime);
        });
        // Salto atrás 15s
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
          get().seek((audio.currentTime) - (details.seekOffset ?? 15));
        });
        // Salto adelante 30s
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
          get().seek((audio.currentTime) + (details.seekOffset ?? 30));
        });
      }

      set({ loadingId: null, playingId: messageId });
      await audio.play();

    } catch (err) {
      releaseAudio();
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TTS]', msg);
      set({ loadingId: null, playingId: null, pausedId: null, lastError: msg });
    }
  },
}));
