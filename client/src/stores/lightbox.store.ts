import { create } from 'zustand';

interface LightboxState {
  src:     string | null;
  name:    string;
  /** Full navigable set (e.g. a character's gallery). Empty when opened as a single image. */
  gallery: string[];
  index:   number;
  open:    (src: string, name: string, gallery?: string[]) => void;
  close:   () => void;
  next:    () => void;
  prev:    () => void;
}

export const useLightboxStore = create<LightboxState>((set, get) => ({
  src:     null,
  name:    '',
  gallery: [],
  index:   0,
  open: (src, name, gallery) => {
    const list = gallery && gallery.length > 0 ? gallery : [];
    const index = list.length > 0 ? Math.max(0, list.indexOf(src)) : 0;
    set({ src, name, gallery: list, index });
  },
  close: () => set({ src: null, name: '', gallery: [], index: 0 }),
  next: () => {
    const { gallery, index } = get();
    if (gallery.length < 2) return;
    const nextIndex = (index + 1) % gallery.length;
    set({ index: nextIndex, src: gallery[nextIndex] });
  },
  prev: () => {
    const { gallery, index } = get();
    if (gallery.length < 2) return;
    const prevIndex = (index - 1 + gallery.length) % gallery.length;
    set({ index: prevIndex, src: gallery[prevIndex] });
  },
}));
