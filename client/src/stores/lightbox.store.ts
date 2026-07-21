import { create } from 'zustand';

interface LightboxState {
  src:         string | null;
  name:        string;
  /** Full navigable set (e.g. a character's gallery). Empty when opened as a single image. */
  gallery:     string[];
  index:       number;
  /** Set only when opened from a character avatar with a known gallery — enables the
   *  "generar escena" panel in ImageLightbox. Null for scene images / other contexts. */
  characterId: string | null;
  open:        (src: string, name: string, gallery?: string[], characterId?: string) => void;
  close:       () => void;
  next:        () => void;
  prev:        () => void;
  /** Appends a freshly-generated image to the gallery and jumps to it. */
  addGenerated: (url: string) => void;
}

export const useLightboxStore = create<LightboxState>((set, get) => ({
  src:         null,
  name:        '',
  gallery:     [],
  index:       0,
  characterId: null,
  open: (src, name, gallery, characterId) => {
    const list = gallery && gallery.length > 0 ? gallery : [];
    const index = list.length > 0 ? Math.max(0, list.indexOf(src)) : 0;
    set({ src, name, gallery: list, index, characterId: characterId ?? null });
  },
  close: () => set({ src: null, name: '', gallery: [], index: 0, characterId: null }),
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
  addGenerated: (url) => {
    const { gallery } = get();
    const list = gallery.length > 0 ? [...gallery, url] : [url];
    set({ gallery: list, index: list.length - 1, src: url });
  },
}));
