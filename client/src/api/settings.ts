import { api } from './client.ts';
import type { AppSettings, UpdateSettingsDto } from '@rpgspeak/shared';

export const settingsApi = {
  get: () => api.get<AppSettings>('/settings'),
  update: (data: UpdateSettingsDto) => api.patch<AppSettings>('/settings', data),
  reset: () => api.post<AppSettings>('/settings/reset', {}),
  getDefault: <K extends keyof AppSettings>(key: K) =>
    api.get<{ key: K; value: AppSettings[K] }>(`/settings/defaults/${key}`),
};
