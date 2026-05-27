import type { LoginResponse, User, CreateUserDto, UpdateUserDto } from '@rpgspeak/shared';

const BASE = '/api';

async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('rpgspeak_token');
  const hasJsonBody = init?.body !== undefined && !(init.body instanceof FormData);
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  const json = await res.json().catch(() => ({ success: false, message: res.statusText }));
  if (!res.ok) throw new Error(json.message ?? 'Request failed');
  return (json as { data: T }).data;
}

export const authApi = {
  login:  (username: string, password: string) =>
    authRequest<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  me: () => authRequest<User>('/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    authRequest<{ message: string }>('/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  updateProfile: (updates: { displayName?: string; appearance?: string }) =>
    authRequest<LoginResponse>('/auth/me', {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  /** Upload a photo as user avatar (multipart). Returns updated LoginResponse. */
  uploadAvatar: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return authRequest<LoginResponse>('/auth/me/avatar', { method: 'POST', body: form });
  },

  /** Remove the user's avatar. */
  deleteAvatar: () =>
    authRequest<LoginResponse>('/auth/me/avatar', { method: 'DELETE' }),

  /** Ask the LLM to generate an SD-optimised appearance description from the user's current text. */
  generateDescription: () =>
    authRequest<{ description: string }>('/auth/me/generate-description', { method: 'POST' }),

  /** Generate a new portrait using the user's avatar as FaceID reference + appearance as prompt. */
  generateInspiration: (customPrompt?: string) =>
    authRequest<{ imageUrl: string }>('/generate/user-inspiration', {
      method: 'POST',
      body: JSON.stringify({ customPrompt }),
    }),
};

export const usersApi = {
  list:   ()                          => authRequest<User[]>('/users'),
  create: (dto: CreateUserDto)        => authRequest<User>('/users', { method: 'POST', body: JSON.stringify(dto) }),
  update: (id: string, dto: UpdateUserDto) =>
    authRequest<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  setActive: (id: string, active: boolean) =>
    authRequest<User>(`/users/${id}/active`, { method: 'PATCH', body: JSON.stringify({ active }) }),
  delete: (id: string) =>
    fetch(`${BASE}/users/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${localStorage.getItem('rpgspeak_token') ?? ''}` },
    }),

  // Content assignments
  getCharacterIds:    (id: string)                    => authRequest<{ characterIds: string[] }>(`/users/${id}/characters`),
  setCharacterIds:    (id: string, ids: string[])     => authRequest<{ characterIds: string[] }>(`/users/${id}/characters`, { method: 'PUT', body: JSON.stringify({ characterIds: ids }) }),
  getStoryIds:        (id: string)                    => authRequest<{ storyIds: string[] }>(`/users/${id}/stories`),
  setStoryIds:        (id: string, ids: string[])     => authRequest<{ storyIds: string[] }>(`/users/${id}/stories`, { method: 'PUT', body: JSON.stringify({ storyIds: ids }) }),
};
