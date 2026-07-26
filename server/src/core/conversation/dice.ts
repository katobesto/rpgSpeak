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
import type { LLMProvider } from '../llm/provider.interface.js';
import { recordBgUsage } from './bg-usage.js';

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

/**
 * Política de "cuándo tirar", por nivel de dificultad de la conversación (ver
 * DiceDifficulty en shared). Es la ÚNICA parte que cambia entre niveles: el
 * formato de la etiqueta y la regla de autoridad (el servidor tira, el modelo
 * narra) son idénticos siempre.
 *
 * El nivel 1 reproduce literalmente la instrucción que había antes de existir
 * el selector, para que las conversaciones ya en curso no cambien de
 * comportamiento al introducirse esta función.
 */
const TRIGGER_POLICY: Record<1 | 2 | 3, string> = {
  1:
    `Cuando el desenlace de una acción sea genuinamente incierto (un reto físico o mental arriesgado, un intento de` +
    ` engañar, esquivar o forzar algo, un golpe en combate), pide una tirada real en vez de decidir tú si sale bien.`,
  2:
    `Pide una tirada SIEMPRE que el jugador intente algo con oposición real o posibilidad auténtica de fallar:` +
    ` un esfuerzo físico exigente, puntería, sigilo, acrobacia, persuadir o intimidar a alguien que no está de acuerdo,` +
    ` cualquier golpe o maniobra en combate, forzar un mecanismo, resistir un efecto. No supongas que sale bien porque` +
    ` el personaje sea competente: la competencia es el modificador, no el resultado.`,
  3:
    `Pide una tirada para CASI CUALQUIER acción deliberada del jugador que no sea pura conversación o desplazamiento` +
    ` trivial. Si el jugador intenta hacer algo — lanzar, saltar, golpear, trepar, apuntar, convencer, registrar,` +
    ` recordar, aguantar — la resuelve el dado, no tú. Ante la duda, TIRA. Solo se resuelven sin dado las acciones` +
    ` sin ningún margen de fallo (abrir una puerta que ya está abierta, mirar alrededor, hablar sin intención de persuadir).`,
};

/**
 * Instrucción para el prompt principal — dónde y cómo pedir una tirada.
 * Devuelve null en el nivel 0: ahí el bloque no se inyecta en absoluto y el
 * modelo ni siquiera sabe que existen los dados.
 *
 * Reescrita tras observar que modelos razonadores (DeepSeek V4) simplemente no
 * la disparaban pese a acciones de riesgo evidente (saltar una valla, un golpe
 * en pleno combate) mientras otros (Gemma) sí — con el bloque en la posición
 * correcta y sin contradicción con el resto del prompt (ver el fix de
 * settings.service.ts en la misma sesión: la vieja regla de "RESOLUCIÓN DE
 * ACCIONES FÍSICAS" condicionaba la tirada a "modo aventura", un concepto ya
 * retirado). La causa que queda tras ese fix: la propia regla de "toda acción
 * SIEMPRE llega a su desenlace en la MISMA respuesta" empuja al modelo a
 * narrar un final satisfactorio ahí mismo, y detenerse en el momento de
 * tensión se siente como una respuesta incompleta — justo lo que esa regla
 * prohíbe. Aplicado el mismo arreglo que ya funcionó con [AFINIDAD] en estos
 * modelos: declarar la tirada EXENTA de esa presión de cierre (parar ahí SÍ
 * cuenta como resolver la acción, no es dejarla a medias) e invertir el sesgo
 * por defecto en los niveles altos (default = tirar; omitir es la excepción,
 * no al revés).
 */
export function diceRollInstruction(level: number): string | null {
  if (level <= 0) return null;
  const policy = TRIGGER_POLICY[(Math.min(3, Math.round(level)) as 1 | 2 | 3)];
  const closing =
    level >= 3
      ? `Ante la duda, pide la tirada: es preferible tirar de más que resolver a dedo algo que podía fallar. Omitirla es el error por defecto en este nivel, no al revés.`
      : level === 2
        ? `Las acciones sin riesgo real NO necesitan tirada — pero no te saltes ninguna en la que sí se pueda fallar.`
        : `Es un marcador técnico: se borra antes de mostrarse. La mayoría de acciones NO necesitan tirada — solo cuando el resultado esté de verdad en juego.`;

  return (
    `## TIRADAS DE DADOS — MARCADOR TÉCNICO OBLIGATORIO — el servidor decide, tú narras\n\n` +
    `IMPORTANTE: pedir una tirada NO es dejar la respuesta a medias ni romper el ritmo narrativo — es la ÚNICA forma legítima de que el desenlace de una acción arriesgada tenga peso real, en vez de que tú lo decidas por conveniencia. La regla de "toda acción llega a su desenlace en la misma respuesta" queda CUMPLIDA en el momento en que pides la tirada: delegar el resultado en el sistema ES resolver la acción, no es una respuesta incompleta.\n\n` +
    `${policy}` +
    ` Al final de tu respuesta, en línea propia:\n` +
    `[TIRADA:Quién|Atributo|CD|qué se está intentando, en pocas palabras]\n` +
    `Ejemplo: [TIRADA:Javier|Destreza|15|colarse junto a los guardias sin ser visto]\n\n` +
    `- Quién: el nombre exacto de quien tira (del jugador o de un personaje del reparto). Puedes dejarlo vacío si es el jugador.\n` +
    `- Atributo: el nombre tal como aparece en su ficha (Fuerza, Destreza, Magia...). Si no tiene ficha o no tiene ese atributo, el modificador será 0 — igualmente válido.\n` +
    `- CD: la dificultad (1-20). Orientativo: 10 trivial con riesgo · 13 moderado · 16 difícil · 19 muy difícil.\n\n` +
    `NO decidas tú el resultado ni lo narres todavía: termina tu respuesta justo en el momento de tensión, antes de saber cómo sale. ` +
    `El sistema tirará el dado y TE devolverá el resultado para que continúes narrando el desenlace en tu siguiente respuesta — nunca inventes ni repitas una tirada porque no te guste el número.\n` +
    `${closing}`
  );
}

/**
 * Árbitro dedicado de "¿hace falta tirada?" — una llamada aparte, de único
 * cometido, ANTES de generar la respuesta narrativa. Mismo diagnóstico y misma
 * solución que ya usa el reloj del mundo para [TIEMPO:...]/[UBICACIÓN:...]
 * (ver refineWorldStateAsync): pedirle al LLM narrador que decida esto en
 * medio de una respuesta ya cargada con ~90 instrucciones no es fiable —
 * verificado en vivo con DeepSeek V4 (nunca disparaba la tirada pese a
 * acciones de riesgo evidente, mientras Gemma sí, con el mismo texto y la
 * misma posición en el prompt). Una llamada corta, con una única pregunta y
 * una respuesta de una línea, no compite con nada.
 *
 * A diferencia del reloj del mundo, que corrige DESPUÉS (un dato descriptivo
 * se puede arreglar sin que se note), la tirada se decide ANTES de narrar:
 * una vez el modelo ya escribió "saltas y aterrizas bien", no hay forma
 * limpia de deshacerlo.
 *
 * Deliberadamente solo cubre acciones DEL JUGADOR — el caso mayoritario y el
 * único que justifica una llamada dedicada. La tirada sobre la acción de un
 * PNJ sigue dependiendo de que el propio narrador la pida con [TIRADA:...] en
 * su respuesta (esa instrucción se mantiene siempre como red de seguridad
 * secundaria: cubre lo que este árbitro no cubre por diseño, y lo que se le
 * escape).
 *
 * Entrada deliberadamente mínima (solo el texto de la acción, sin historial)
 * y salida de una sola línea con formato fijo — el coste añadido por turno es
 * el de un intercambio muy corto, no el de una llamada de generación. Falla
 * en silencio hacia "no hace falta tirada" ante cualquier error, timeout o
 * respuesta que no siga el formato exacto: nunca bloquea ni alarga el turno
 * principal más de lo que tarda esta consulta breve.
 */
/**
 * Bloque para cuando la tirada YA se resolvió (árbitro dedicado, ver más
 * abajo) antes de generar la respuesta narrativa: al narrador no se le pide
 * que decida ni que pida nada — se le entrega el resultado como un hecho
 * consumado, igual que la cabecera del mundo. Sustituye a diceRollInstruction
 * para este turno concreto (no tiene sentido pedir una tirada que ya ocurrió).
 *
 * La instrucción de FALLO es deliberadamente explícita sobre qué implica: en
 * pruebas reales el modelo aceptaba el fallo pero lo narraba como un éxito con
 * un roce cosmético ("aterrizas sano y salvo, con las manos arañadas") — la
 * palabra "FALLO" sola no bastaba para que el personaje NO consiguiera su
 * objetivo. Ahora se explicita sin ambigüedad: el objetivo declarado NO se
 * logra en este intento.
 */
export function buildResolvedDiceBlock(roll: DiceRollResult): string {
  const isCritSuccess = roll.critical === 'success';
  const isCritFailure = roll.critical === 'failure';
  const outcomeLabel = isCritSuccess ? 'ÉXITO CRÍTICO (20 natural)'
    : isCritFailure ? 'FALLO CRÍTICO (1 natural)'
    : roll.success ? 'ÉXITO' : 'FALLO';
  const consequence = (isCritFailure || (!roll.success && !isCritSuccess))
    ? (isCritFailure
        ? ` FALLO CRÍTICO: el intento no solo fracasa, sale mal de la peor manera posible — con una complicación seria añadida (te haces daño de verdad, te descubren, rompes o pierdes algo, empeoras tu situación), no un simple traspié cosmético.`
        : ` FALLO: ${roll.who} NO consigue su objetivo en este intento — no llega, no lo logra, no funciona. Puede quedar a medio camino, ser interrumpido, o sufrir una complicación real; lo único que NO es válido es narrar el objetivo como logrado con un pequeño coste decorativo (un rasguño, un despeine). El fallo debe notarse en la situación, no solo en el estilo.`)
    : (isCritSuccess
        ? ` ÉXITO CRÍTICO: no solo lo consigue, sale todo lo bien que podría salir — con algún extra o ventaja inesperada.`
        : ` ÉXITO: ${roll.who} consigue su objetivo, con la dificultad y el esfuerzo propios de la escena, pero lo consigue.`);
  return (
    `## TIRADA YA RESUELTA — HECHO CONSUMADO, NO LO VUELVAS A DECIDIR\n` +
    `El sistema ya ha tirado el dado por el intento de ${roll.who} (${roll.attribute}, CD ${roll.cd}): ` +
    `${roll.natural} natural + ${roll.modifier} de modificador = ${roll.total} → ${outcomeLabel}.\n` +
    `${consequence}\n` +
    `Narra el desenlace coherente con este resultado — no lo suavices ni lo contradigas, no repitas los números en la narración, ` +
    `y no emitas [TIRADA:...] para esta misma acción: ya está resuelta.`
  );
}

export async function resolveDiceTriggerAsync(
  llm: LLMProvider,
  modelId: string,
  level: number,
  playerActionText: string,
  playerSheet: RpgStats | null | undefined,
  conversationId?: string,
): Promise<{ attribute: string; cd: number } | null> {
  if (level <= 0 || !playerActionText.trim()) return null;

  const policy = TRIGGER_POLICY[(Math.min(3, Math.round(level)) as 1 | 2 | 3)];
  const statNames = playerSheet?.stats ? Object.keys(playerSheet.stats) : [];
  const statsHint = statNames.length
    ? `Atributos de la ficha del jugador (usa uno de estos si encaja; si ninguno encaja, elige el más cercano en español): ${statNames.join(', ')}.\n`
    : '';

  const system =
    `Eres el árbitro técnico de un sistema de rol. Tu ÚNICA tarea es decidir si la acción del jugador necesita una tirada de d20, según esta política de la partida:\n` +
    `${policy}\n\n` +
    statsHint +
    `Si hace falta tirada, elige también una CD (Clase de Dificultad) de 1 a 20 — 10 trivial con riesgo, 13 moderado, 16 difícil, 19 muy difícil.\n` +
    `No expliques tu razonamiento. Responde ÚNICAMENTE con una de estas dos líneas, EXACTAMENTE con este formato y nada más:\n` +
    `NO\n` +
    `SI|Atributo|CD`;

  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000));
    const result = await Promise.race([
      llm.generate({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Acción del jugador: "${playerActionText.trim().slice(0, 400)}"` },
        ],
        model: modelId,
        temperature: 0,
        maxTokens: 20,
        stream: false,
      }),
      timeout,
    ]);
    if (!result) {
      console.log('[dice-referee] Timeout consultando al árbitro — sin tirada este turno');
      return null;
    }

    if (conversationId) recordBgUsage(conversationId, 'arbitro-dados', result.tokens);

    const line = result.content.trim().split('\n')[0].trim();
    if (/^NO\b/i.test(line)) return null;

    const m = /^S[IÍ]\s*\|\s*([^|]+?)\s*\|\s*(\d{1,2})\s*$/i.exec(line);
    if (!m) {
      if (!/^NO\b/i.test(line)) console.warn(`[dice-referee] Respuesta no reconocida, se ignora: "${line}"`);
      return null;
    }

    const cd = Math.min(20, Math.max(1, parseInt(m[2], 10) || 10));
    console.log(`[dice-referee] Tirada activada: ${m[1].trim()} (CD ${cd})`);
    return { attribute: m[1].trim(), cd };
  } catch (err) {
    console.error('[dice-referee] Error al consultar el árbitro:', err);
    return null;
  }
}
