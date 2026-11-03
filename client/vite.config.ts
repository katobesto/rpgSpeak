import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { execSync } from 'child_process';

// Versión de la app: fecha del commit de HEAD + SHA corto, capturados al arrancar
// Vite (dev) o al construir (build). Identifica de forma estable la versión que
// se está sirviendo. Si git no está disponible, cae a la hora de build.
function resolveAppVersion(): string {
  try {
    const date = execSync("git log -1 --format=%cd --date=format:'%d/%m/%y %H:%M'")
      .toString().trim().replace(/'/g, '');
    const sha = execSync('git rev-parse --short HEAD').toString().trim();
    return `${date} · ${sha}`;
  } catch {
    return new Date().toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(resolveAppVersion()),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@rpgspeak/shared': path.resolve(__dirname, '../shared/types/index.ts'),
    },
  },
  server: {
    // Respeta el PORT que asigne el entorno (p. ej. el harness de preview con
    // autoPort); si no está, usa 5173. dev.sh usa CLIENT_PORT y no exporta PORT,
    // así que ahí sigue arrancando en 5173 como siempre.
    port: Number(process.env.PORT) || 5173,
    host: '0.0.0.0',
    allowedHosts: ['katobest.ddns.net'],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // El stream de generación puede estar varios minutos sin emitir tokens
        // (prefill largo, modelo local lento, razonamiento prolongado). 4 min se
        // quedaba corto: el proxy cortaba el SSE en mitad de la respuesta.
        // 8 min deja margen para prefills de hasta ~7 min; el latido SSE del
        // servidor (: ping cada 15 s) evita además los cortes por inactividad.
        proxyTimeout: 480_000,
        timeout: 480_000,
      },
      '/images': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          ui: ['lucide-react', 'marked', 'dompurify'],
        },
      },
    },
  },
});
