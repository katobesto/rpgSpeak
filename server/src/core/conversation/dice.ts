// ── Tiradas de dados resueltas por el servidor ───────────────────────────────
//
// rpgSpeak ya tuvo mecánicas de dados y se retiraron: "el LLM interpretaba
// stats y combate a su aire porque no había ningún sistema real detrás" (ver
// el comentario histórico en context-builder.ts). El diagnóstico era correcto;
// la conclusión no. El arreglo no es quitar los dados — es que los tire el
// SERVIDOR. Sin un número real, "castigar las malas decisiones" es una
// decisión arbitraria del modelo, que por defecto tiende a la complacencia.
// Con un d20 real, el fracaso es legítimo y no negociable.
//
// El modelo NUNCA decide el resultado. Pide la tirada con una etiqueta
// ([TIRADA:Quién|Atributo|CD|descripción]), el servidor tira, y el resultado
// vuelve al modelo como un HECHO consumado para que narre el desenlace — la
// misma relación de autoridad que ya rige la cabecera del mundo: el modelo
// aporta el juicio narrativo (cuándo tirar, sobre qué), el servidor aporta el
// número.

import type { Character, RpgStats, DiceRollResult } from '@rpgspeak/shared';
import { matchCharacterName } from '@rpgspeak/shared';

export type { DiceRollResult };

/** Minúsculas, sin tildes — para comparar nombres de atributo tolerando cómo
 *  los escriba el modelo ("Destreza" / "destreza" / "DESTREZA"). */
function normalizeStatName(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/**
 * Modificador real de un atributo, a partir de la ficha (del jugador o de un
 * Character). Fórmula D&D estándar (valor-10)/2 redondeado hacia abajo — los
 * propios placeholders de la UI de la ficha ya sugieren nombres al estilo
 * D&D (Fuerza, Destreza, Magia, Carisma), así que es la convención que el
 * usuario ya está usando, no una impuesta aparte.
 *
 * Sin ficha, o sin ese atributo en ella, el modificador es 0 — un resultado
 * limpio y explicable, nunca un valor inventado.
 */
export function resolveRollModifier(sheet: RpgStats | null | undefined, attribute: string): number {
  if (!sheet?.stats) return 0;
  const target = normalizeStatName(attribute);
  for (const [key, value] of Object.entries(sheet.stats)) {
    if (normalizeStatName(key) === target && typeof value === 'number') {
      return Math.floor((value - 10) / 2);
    }
  }
  return 0;
}

/**
 * Resuelve quién tira: si `who` nombra a un personaje del reparto, su
 * `rpgStats`; en cualquier otro caso (vacío, "jugador", "tú", el nombre del
 * jugador, o un nombre que no casa con nadie del reparto) se asume que tira
 * el JUGADOR — es con diferencia el caso más común y el más seguro por
 * defecto: un roce con el nombre de un PNJ nunca debe dejar la tirada del
 * jugador sin resolver.
 */
export function resolveRollSheet(
  who: string,
  playerSheet: RpgStats | null | undefined,
  playerDisplayName: string | undefined,
  cast: Character[],
): { sheet: RpgStats | null | undefined; resolvedWho: string } {
  const trimmed = who.trim();
  const isPlayerAlias =
    !trimmed ||
    /^(jugador|t[uú]|player)$/i.test(trimmed) ||
    (playerDisplayName ? normalizeStatName(trimmed) === normalizeStatName(playerDisplayName) : false);

  if (!isPlayerAlias) {
    const found = matchCharacterName(trimmed, cast);
    if (found) return { sheet: found.rpgStats, resolvedWho: found.name };
  }
  return { sheet: playerSheet, resolvedWho: playerDisplayName?.trim() || 'el jugador' };
}

/**
 * Tira el d20 y resuelve el resultado. `rng` es inyectable para pruebas
 * deterministas (por defecto Math.random).
 *
 * Crítico natural manda sobre la CD, regla estándar: un 20 natural siempre
 * triunfa, un 1 natural siempre falla, sin importar el modificador ni la
 * dificultad — es lo que hace que una tirada se sienta como un dado de
 * verdad y no como una comparación aritmética disfrazada.
 */
export function rollDice(
  who: string,
  attribute: string,
  cd: number,
  description: string,
  modifier: number,
  rng: () => number = Math.random,
): DiceRollResult {
  const natural = 1 + Math.floor(rng() * 20);
  const total = natural + modifier;
  const critical = natural === 20 ? 'success' : natural === 1 ? 'failure' : null;
  const success = critical !== null ? critical === 'success' : total >= cd;
  return { who, attribute, cd, description, natural, modifier, total, success, critical };
}

/** Etiqueta que pide una tirada: [TIRADA:Quién|Atributo|CD|descripción].
 *  Formato de pipes — no dos-puntos-y-cierre — a propósito: es el que este
 *  mismo modelo ya rellena de forma fiable para [PERSONAJE:...]/[PNJ:...]/
 *  [MEMORIA:...]; el formato con cierre generó tirones de formato reales
 *  (ver la corrección de [MEMORIA:...] en la misma sesión). */
export const DICE_ROLL_RE = /\[TIRADA:\s*([^|\]]*)\|([^|\]]+)\|(\d{1,2})\|([^\]]*)\]/gi;

/** Instrucción para el prompt principal — dónde y cómo pedir una tirada. */
export const DICE_ROLL_INSTRUCTION =
  `## TIRADAS DE DADOS — el servidor decide, tú narras\n\n` +
  `Cuando el desenlace de una acción sea genuinamente incierto (un reto físico o mental arriesgado, un intento de` +
  ` engañar, esquivar o forzar algo, un golpe en combate), pide una tirada real en vez de decidir tú si sale bien.` +
  ` Al final de tu respuesta, en línea propia:\n` +
  `[TIRADA:Quién|Atributo|CD|qué se está intentando, en pocas palabras]\n` +
  `Ejemplo: [TIRADA:Javier|Destreza|15|colarse junto a los guardias sin ser visto]\n\n` +
  `- Quién: el nombre exacto de quien tira (del jugador o de un personaje del reparto). Puedes dejarlo vacío si es el jugador.\n` +
  `- Atributo: el nombre tal como aparece en su ficha (Fuerza, Destreza, Magia...). Si no tiene ficha o no tiene ese atributo, el modificador será 0 — igualmente válido.\n` +
  `- CD: la dificultad (1-20). Orientativo: 10 trivial con riesgo · 13 moderado · 16 difícil · 19 muy difícil.\n\n` +
  `NO decidas tú el resultado ni lo narres todavía: termina tu respuesta justo en el momento de tensión, antes de saber cómo sale. ` +
  `El sistema tirará el dado y TE devolverá el resultado para que continúes narrando el desenlace en tu siguiente respuesta — nunca inventes ni repitas una tirada porque no te guste el número.\n` +
  `Es un marcador técnico: se borra antes de mostrarse. La mayoría de acciones NO necesitan tirada — solo cuando el resultado esté de verdad en juego.`;
