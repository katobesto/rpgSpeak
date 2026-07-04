/// <reference types="vite/client" />

/** Versión de la app inyectada en build por Vite: fecha del commit de HEAD + SHA
 *  corto (o la hora de build como fallback si git no está disponible). */
declare const __APP_VERSION__: string;
