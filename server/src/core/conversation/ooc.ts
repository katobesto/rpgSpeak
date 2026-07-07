// ── Notas OOC (out-of-character) del jugador ─────────────────────────────────
//
// Convención: el texto que el jugador escribe entre PARÉNTESIS SIMPLES es una
// nota "fuera de personaje" — un canal de dirección dirigido SOLO a la IA, no a
// los personajes. Sirve para expresar el pensamiento privado del jugador o para
// corregir la deriva argumental sin que ello:
//   · lo perciban o conozcan los personajes,
//   · altere la afinidad o cree memorias,
//   · se cristalice como hecho en los resúmenes o el índice de contexto.
//
// Por eso el paréntesis se retira de la copia del mensaje que ven los
// analizadores (afinidad, memoria, detección de acciones) y de los generadores
// de resumen / índice. La IA principal SÍ lo recibe (en el mensaje íntegro del
// historial) e interpreta la nota según el bloque de convención del prompt.
// La moderación NSFW es la única excepción: examina el mensaje íntegro para que
// no se pueda usar el paréntesis como vía de evasión.

/** Un solo nivel de anidamiento basta para el chat; el flag global captura
 *  varias notas en el mismo mensaje. Requiere paréntesis cerrado. */
const OOC_RE = /\([^()]*\)/g;

/** Devuelve el mensaje sin las notas OOC (paréntesis y su contenido), con los
 *  espacios sobrantes colapsados. Si el mensaje era SOLO una nota OOC, devuelve
 *  cadena vacía. */
export function stripOocNotes(text: string): string {
  return text.replace(OOC_RE, ' ').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:!?])/g, '$1').trim();
}

/** true si el mensaje contiene al menos una nota OOC. */
export function hasOocNote(text: string): boolean {
  OOC_RE.lastIndex = 0;
  return OOC_RE.test(text);
}

/** Bloque estático (cacheable) que explica la convención OOC a la IA. Se inyecta
 *  en el mensaje de sistema en todos los modos. */
export const OOC_CONVENTION_BLOCK =
  `## NOTAS DEL JUGADOR ENTRE PARÉNTESIS — SOLO PARA TI (OOC)\n` +
  `Cuando el jugador escribe algo entre paréntesis simples ( … ), es una nota FUERA DE PERSONAJE dirigida ` +
  `EXCLUSIVAMENTE a ti como director de la historia: su pensamiento interno, una intención o una indicación ` +
  `para guiar la escena. NO es algo que su personaje diga o haga en la ficción.\n` +
  `- Los personajes NO oyen, NO ven y NO conocen el contenido del paréntesis. Jamás reaccionan a él como si ` +
  `el jugador lo hubiera dicho o hecho, ni lo mencionan, ni lo dan por sabido.\n` +
  `- No cambia la afinidad ni las relaciones: es información para ti, no un acto del jugador dentro del mundo.\n` +
  `- Úsalo para orientar tu narración con sutileza (el tono, hacia dónde llevas la escena, qué matices ` +
  `resaltas), pero sin delatarlo. Ejemplo: ante "(en el fondo estoy enamorado de ella)", NO hagas que el ` +
  `personaje se entere de ese amor; como mucho, deja que la escena respire esa tensión desde fuera.\n` +
  `- Lo que el jugador quiere que su personaje diga o haga de verdad lo escribe SIN paréntesis. Solo el texto ` +
  `entre paréntesis es OOC.`;
