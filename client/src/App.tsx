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
