import React, { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
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
  const { theme, initForUser } = useUiStore();
  const { isAuthenticated, user, clearAuth } = useAuthStore();

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
  useEffect(() => {
    window.history.pushState(null, '');
    const handlePopState = () => window.history.pushState(null, '');
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

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
