// ── Higiene tipográfica de la narración ──────────────────────────────────────
//
// Los modelos —sobre todo los rápidos/ligeros— tienden a pegar un gesto entre
// asteriscos directamente al texto que sigue, sin puntuación de por medio:
//   **Director:** *la mira* El espíritu guardián del bosque...
// Leído en voz alta, "la mira El espíritu" suena como una frase cortada, no
// como una pausa — dos ideas que deberían estar separadas se funden en una.
// El prompt ya pide puntuación explícita (ver narratorPrompt en
// settings.service.ts), pero un modelo rápido no la sigue de forma fiable, así
// que esta normalización determinista actúa como red de seguridad: nunca
// depende de que el modelo obedezca, corrige el patrón siempre que aparece.
//
// Solo se toca el caso de alta confianza: un gesto en minúscula (no un nombre
// propio ni el arranque de un párrafo narrativo normal) que termina sin punto
// y al que sigue, tras un espacio, una mayúscula — la firma inequívoca de una
// frase nueva que arrancó pegada a la anterior. Los gestos que continúan la
// MISMA frase en minúscula ("*sonríe* y te mira") se dejan intactos: ahí la
// ambigüedad es baja y forzar puntuación rompería la frase real.
const DANGLING_ACTION_RE = /\*([a-záéíóúñ][^*\n]*[^\s*.!?…])\*(?=[ \t]+[A-ZÁÉÍÓÚÑ¿¡])/g;

export function fixDanglingActionPunctuation(text: string): string {
  return text.replace(DANGLING_ACTION_RE, (_match, action: string) => `*${action}.*`);
}
