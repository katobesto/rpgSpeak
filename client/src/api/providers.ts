import { api } from './client.ts';
import type { Provider, ProviderModel, CreateProviderDto, UpdateProviderDto } from '@rpgspeak/shared';

export const providersApi = {
  list: () => api.get<Provider[]>('/providers'),
  get: (id: string) => api.get<Provider>(`/providers/${id}`),
  create: (data: CreateProviderDto) => api.post<Provider>('/providers', data),
  update: (id: string, data: UpdateProviderDto) => api.patch<Provider>(`/providers/${id}`, data),
  delete: (id: string) => api.delete(`/providers/${id}`),
  listModels: (id: string) => api.get<ProviderModel[]>(`/providers/${id}/models`),
  validate: (id: string) => api.get<{ valid: boolean; error?: string }>(`/providers/${id}/validate`),
};
