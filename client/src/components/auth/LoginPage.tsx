import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { authApi } from '../../api/auth.ts';
import { useAuthStore } from '../../stores/auth.store.ts';
import { Input } from '../ui/Input.tsx';

export function LoginPage() {
  const setAuth = useAuthStore((s) => s.setAuth);
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token, user } = await authApi.login(username, password);
      qc.clear();   // descarta cualquier dato en caché de la sesión anterior
      setAuth(token, user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al iniciar sesión');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
      <div className="w-full max-w-sm">
        {/* Logo / title */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-text-primary tracking-tight">rpgSpeak</h1>
          <p className="text-sm text-text-muted mt-1">Narrativa de rol con IA</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="border border-border rounded-xl p-8 space-y-5 shadow-xl"
          style={{ background: 'var(--surface-1)' }}
        >
          <h2 className="text-lg font-semibold text-text-primary text-center">Iniciar sesión</h2>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg px-4 py-2.5">
              {error}
            </div>
          )}

          <Input
            label="Usuario"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            placeholder="admin"
          />

          <Input
            label="Contraseña"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            placeholder="••••••••"
          />

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full py-2.5 rounded-lg bg-accent text-white font-medium text-sm
                       hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed
                       transition-colors"
          >
            {loading ? 'Iniciando sesión…' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}
