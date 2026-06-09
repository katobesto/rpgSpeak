import React, { useEffect, useRef } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { MainLayout } from './components/layout/MainLayout.tsx';
import { ImageLightbox } from './components/ui/ImageLightbox.tsx';
import { ChatPage } from './pages/ChatPage.tsx';
import { CharactersPage } from './pages/CharactersPage.tsx';
import { StoriesPage } from './pages/StoriesPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { LoginPage } from './components/auth/LoginPage.tsx';
import { useUiStore } from './stores/ui.store.ts';
import { useAuthStore } from './stores/auth.store.ts';

export default function App() {
  const { theme, initForUser, mobileSidebarOpen, setMobileSidebarOpen } = useUiStore();
  const { isAuthenticated, user, clearAuth } = useAuthStore();
  const location = useLocation();

  // Load per-user appearance settings (localStorage) on login / page refresh
  useEffect(() => {
    if (isAuthenticated && user?.id) {
      initForUser(user.id);
    }
  }, [isAuthenticated, user?.id]);

  // Global 401 interceptor — fired by client.ts when the server rejects the token.
  // Clears Zustand auth state so the component tree immediately renders <LoginPage>.
  useEffect(() => {
    const handle = () => clearAuth();
    window.addEventListener('rpgspeak:unauthorized', handle);
    return () => window.removeEventListener('rpgspeak:unauthorized', handle);
  }, [clearAuth]);

  // Apply persisted theme class on initial render (before initForUser fires)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.classList.toggle('theme-light', theme === 'light');
  }, [theme]);

  // Prevent mobile swipe-back gesture from leaving the app.
  //
  // How it works: we push a duplicate history entry on mount so there is always
  // at least one "fake" entry behind the current one.  Whenever the browser
  // fires a popstate event (swipe-back / hardware back button), we immediately
  // push again — pushState never fires popstate, so there is no infinite loop.
  //
  // React Router still handles the URL change first (its popstate listener was
  // registered earlier), so in-app navigation via the back gesture does work for
  // one step (e.g. /characters → /chat), but repeated swipes stay put at the
  // current page instead of leaving the app or the browser.
  //
  // Special case — Chat page (/): instead of doing nothing, the gesture opens
  // (or closes) the left sidebar, matching the native-app feel.
  //
  // We use refs so the single-mount effect always reads the latest values
  // without needing to be re-registered on every render.
  const pathnameRef        = useRef(location.pathname);
  const mobileSidebarRef   = useRef(mobileSidebarOpen);
  const setSidebarRef      = useRef(setMobileSidebarOpen);
  useEffect(() => { pathnameRef.current = location.pathname; },  [location.pathname]);
  useEffect(() => { mobileSidebarRef.current = mobileSidebarOpen; }, [mobileSidebarOpen]);

  useEffect(() => {
    window.history.pushState(null, '');
    const handlePopState = () => {
      // Always re-push to prevent leaving the app
      window.history.pushState(null, '');
      // On the chat page, use the gesture to toggle the sidebar drawer
      if (pathnameRef.current === '/') {
        setSidebarRef.current(!mobileSidebarRef.current);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <>
      <ImageLightbox />
      <MainLayout>
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/characters" element={<CharactersPage />} />
          <Route path="/stories" element={<StoriesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </MainLayout>
    </>
  );
}
