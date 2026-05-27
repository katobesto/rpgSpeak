import { create } from 'zustand';
import type { User } from '@rpgspeak/shared';

const TOKEN_KEY = 'rpgspeak_token';
const USER_KEY  = 'rpgspeak_user';

interface AuthStore {
  token:           string | null;
  user:            User   | null;
  isAuthenticated: boolean;
  isAdmin:         boolean;

  setAuth:  (token: string, user: User) => void;
  clearAuth: () => void;
}

function loadStored(): { token: string | null; user: User | null } {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw   = localStorage.getItem(USER_KEY);
    const user  = raw ? (JSON.parse(raw) as User) : null;
    return { token, user };
  } catch {
    return { token: null, user: null };
  }
}

const { token: storedToken, user: storedUser } = loadStored();

export const useAuthStore = create<AuthStore>((set) => ({
  token:           storedToken,
  user:            storedUser,
  isAuthenticated: !!storedToken,
  isAdmin:         storedUser?.role === 'admin',

  setAuth(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ token, user, isAuthenticated: true, isAdmin: user.role === 'admin' });
  },

  clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    set({ token: null, user: null, isAuthenticated: false, isAdmin: false });
  },
}));
