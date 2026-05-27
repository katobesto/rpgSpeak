import { create } from 'zustand';

interface LightboxState {
  src:   string | null;
  name:  string;
  open:  (src: string, name: string) => void;
  close: () => void;
}

export const useLightboxStore = create<LightboxState>((set) => ({
  src:   null,
  name:  '',
  open:  (src, name) => set({ src, name }),
  close: () => set({ src: null, name: '' }),
}));
