import { api, getAuthHeader } from './client.ts';
import type { TtsVoice } from '@rpgspeak/shared';

export interface TtsStatus {
  online: boolean;
  modelLoaded: boolean;
  modelLoading: boolean;
  device?: string;
}

export const ttsApi = {
  /** Check whether the Python TTS service is reachable. */
  status: () => api.get<TtsStatus>('/tts/status'),

  /** List voices from the Python service (includes availability). Falls back to []. */
  voices: () => api.get<TtsVoice[]>('/tts/voices'),

  /** Download a voice reference WAV via the Python service. */
  downloadVoice: (voiceId: string) =>
    api.post<{ success: boolean; message?: string }>('/tts/voices/download', { voiceId }),

  /**
   * Synthesize speech.
   * Returns a raw fetch Response so the caller can stream/blob the binary audio.
   */
  synthesizeRaw: (params: {
    text: string;
    voiceId: string;
    speed: number;
    temperature: number;
  }): Promise<Response> =>
    fetch('/api/tts/synthesize', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body:    JSON.stringify(params),
    }),
};
