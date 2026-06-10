import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Panel = 'characters' | 'stories' | 'settings' | null;
type Modal = 'character-editor' | 'story-editor' | 'provider-editor' | 'conversation-new' | null;

export interface AppearancePrefs {
  theme: 'dark' | 'light';
  accentColor: string;
  fontSize: 'sm' | 'md' | 'lg';
  showTimestamps: boolean;
  showTokenCount: boolean;
}

const DEFAULT_APPEARANCE: AppearancePrefs = {
  theme: 'dark',
  accentColor: '#7c3aed',  // matches --accent in index.css
  fontSize: 'md',
  showTimestamps: false,
  showTokenCount: false,
};

const FONT_SIZE_MAP: Record<string, string> = {
  sm: '87.5%',
  md: '100%',
  lg: '112.5%',
};

function applyAppearance(prefs: AppearancePrefs): void {
  document.documentElement.classList.toggle('dark', prefs.theme === 'dark');
  document.documentElement.classList.toggle('theme-light', prefs.theme === 'light');
  if (prefs.accentColor) {
    document.documentElement.style.setProperty('--accent', prefs.accentColor);
  }
  document.documentElement.style.fontSize = FONT_SIZE_MAP[prefs.fontSize] ?? '100%';
}

interface UiState {
  activePanel: Panel;
  activeModal: Modal;
  modalData: unknown;
  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  mobileSidebarOpen: boolean;   // overlay drawer on small screens (not persisted)
  theme: 'dark' | 'light';     // kept for initial class application before login

  /** Per-user appearance preferences — managed via initForUser/setAppearancePref */
  appearance: AppearancePrefs;
  _appearanceUserId: string | null;

  setPanel: (panel: Panel) => void;
  openModal: (modal: Modal, data?: unknown) => void;
  closeModal: () => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setMobileSidebarOpen: (open: boolean) => void;
  /** @deprecated Kept for backward compat — prefer setAppearancePref('theme', ...) */
  setTheme: (theme: 'dark' | 'light') => void;

  /** Load per-user appearance from localStorage and apply to DOM */
  initForUser: (userId: string) => void;
  /** Reset appearance to defaults on logout */
  clearUserPrefs: () => void;
  /** Update one appearance pref, apply to DOM immediately, and persist to localStorage */
  setAppearancePref: <K extends keyof AppearancePrefs>(key: K, value: AppearancePrefs[K]) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      activePanel: 'characters',
      activeModal: null,
      modalData: null,
      sidebarCollapsed: false,
      rightPanelCollapsed: false,
      mobileSidebarOpen: false,
      theme: 'dark',
      appearance: { ...DEFAULT_APPEARANCE },
      _appearanceUserId: null,

      setPanel: (panel) => set({ activePanel: panel }),
      openModal: (modal, data = null) => set({ activeModal: modal, modalData: data }),
      closeModal: () => set({ activeModal: null, modalData: null }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleRightPanel: () => set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
      setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
      setTheme: (theme) => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        document.documentElement.classList.toggle('theme-light', theme === 'light');
        set({ theme });
      },

      initForUser: (userId) => {
        const stored = localStorage.getItem(`rpgspeak-appearance-${userId}`);
        // Base on the last known in-memory/persisted appearance (not hardcoded
        // defaults) so that, if the per-user key was somehow never written
        // (e.g. a toggle changed before _appearanceUserId was set), the user's
        // last applied preferences aren't silently lost on next load.
        const base: AppearancePrefs = { ...DEFAULT_APPEARANCE, ...get().appearance, theme: get().theme };
        const prefs: AppearancePrefs = stored
          ? { ...base, ...JSON.parse(stored) }
          : base;
        applyAppearance(prefs);
        set({ appearance: prefs, _appearanceUserId: userId, theme: prefs.theme });
        // Backfill the per-user key immediately so future loads are consistent
        // even if it didn't exist yet.
        localStorage.setItem(`rpgspeak-appearance-${userId}`, JSON.stringify(prefs));
      },

      clearUserPrefs: () => {
        set({ appearance: { ...DEFAULT_APPEARANCE }, _appearanceUserId: null });
      },

      setAppearancePref: (key, value) => {
        set((s) => {
          const newAppearance = { ...s.appearance, [key]: value };
          // Apply DOM side-effects immediately
          if (key === 'theme') {
            const t = value as 'dark' | 'light';
            document.documentElement.classList.toggle('dark', t === 'dark');
            document.documentElement.classList.toggle('theme-light', t === 'light');
          }
          if (key === 'accentColor' && value) {
            document.documentElement.style.setProperty('--accent', value as string);
          }
          if (key === 'fontSize') {
            document.documentElement.style.fontSize = FONT_SIZE_MAP[value as string] ?? '100%';
          }
          // Persist to user-specific localStorage key
          if (s._appearanceUserId) {
            localStorage.setItem(
              `rpgspeak-appearance-${s._appearanceUserId}`,
              JSON.stringify(newAppearance),
            );
          }
          return {
            appearance: newAppearance,
            ...(key === 'theme' ? { theme: value as 'dark' | 'light' } : {}),
          };
        });
      },
    }),
    {
      name: 'rpgspeak-ui',
      // Layout state is global; appearance is additionally managed per-user via
      // initForUser (rpgspeak-appearance-${userId}), but we also keep a generic
      // copy here as a fallback so a toggle change is never lost even if the
      // per-user key write is somehow missed (e.g. before _appearanceUserId is set).
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        rightPanelCollapsed: state.rightPanelCollapsed,
        theme: state.theme,
        appearance: state.appearance,
      }),
    },
  ),
);
