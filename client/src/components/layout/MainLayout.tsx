import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Menu, Zap, Maximize2, Minimize2 } from 'lucide-react';
import { Sidebar } from './Sidebar.tsx';
import { useUiStore } from '../../stores/ui.store.ts';

interface MainLayoutProps {
  children: React.ReactNode;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
}

export function MainLayout({ children }: MainLayoutProps) {
  const sidebarCollapsed     = useUiStore((s) => s.sidebarCollapsed);
  const mobileSidebarOpen    = useUiStore((s) => s.mobileSidebarOpen);
  const setMobileSidebarOpen = useUiStore((s) => s.setMobileSidebarOpen);
  const isMobile             = useIsMobile();

  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  // Close mobile drawer on navigation
  const location = useLocation();
  useEffect(() => { if (location.pathname !== '/') setMobileSidebarOpen(false); }, [location.pathname]);

  // On mobile the sidebar is always "expanded" (labels always visible)
  const effectiveCollapsed = isMobile ? false : sidebarCollapsed;

  return (
    <div className="flex flex-col h-dvh w-screen overflow-hidden" style={{ background: 'var(--surface-0)' }}>

      {/* ── Mobile top bar ──────────────────────────────────────────────────
          Only visible on small screens. Provides the hamburger + logo.
          Hidden on md+ because the sidebar is always inline there.
      */}
      <div
        className="md:hidden flex-shrink-0 flex items-center gap-3 px-3 h-12 border-b border-border z-20"
        style={{ background: 'var(--surface-1)' }}
      >
        <button
          onClick={() => setMobileSidebarOpen(true)}
          className="p-2 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
          aria-label="Abrir menú"
        >
          <Menu size={20} />
        </button>
        <div className="flex items-center gap-2 flex-1">
          <Zap size={16} className="text-accent" />
          <span className="font-bold text-sm tracking-tight">rpgSpeak</span>
        </div>
        <button
          onClick={toggleFullscreen}
          className="p-2 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
          aria-label={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
        >
          {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </button>
      </div>

      {/* ── Body row (sidebar + content) ────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Mobile backdrop */}
        {mobileSidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            onClick={() => setMobileSidebarOpen(false)}
          />
        )}

        {/* ── Sidebar ───────────────────────────────────────────────────────
            Desktop (md+): inline, shrinks to w-14 when collapsed
            Mobile (<md):  fixed full-width overlay, slides in from left
        */}
        <div
          className={[
            // Desktop: inline, width animated — overflow-hidden evita que el
            // contenido empuje el ancho más allá del valor definido (w-14/w-72)
            'md:relative md:flex md:flex-shrink-0 md:translate-x-0',
            'md:transition-[width] md:duration-200 md:overflow-hidden',
            effectiveCollapsed ? 'md:w-14' : 'md:w-72',
            // Mobile: fixed full-width overlay
            'fixed inset-y-0 left-0 z-50 w-full md:w-auto overflow-hidden',
            'transition-transform duration-250 ease-in-out',
            mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
            'border-r border-border',
          ].join(' ')}
          style={{
            background: 'var(--surface-1)',
            maxWidth: effectiveCollapsed ? '56px' : '288px',
            minWidth: effectiveCollapsed ? '56px' : '288px',
            width:    effectiveCollapsed ? '56px' : '288px',
          }}
        >
          <Sidebar collapsed={effectiveCollapsed} isMobile={isMobile} />
        </div>

        {/* ── Main content ──────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {children}
        </div>

      </div>
    </div>
  );
}
