// ── Contabilidad de tokens de las llamadas en segundo plano ──────────────────
//
// Cada llamada al LLM que NO es la generación principal del chat (director de
// escena, resúmenes, anclaje del mundo, índice de contexto, analizadores del
// fast LLM, moderación...) consume tokens reales que hasta ahora no se
// contabilizaban en ninguna parte: las estadísticas solo mostraban el coste del
// chat. Este módulo cierra ese hueco — el coste real no debe tener nada oculto.
//
// El acumulado histórico vive en `conversation.metadata.bgTokens` con el mismo
// patrón "leer-fresco → merge → persistir" que ya usan deathLoop/worldState
// (las llamadas de fondo corren en secuencia, no en paralelo, precisamente para
// que estos merges no se pisen). El delta de un turno concreto se calcula por
// diferencia de instantáneas y se adjunta al mensaje que lo disparó.

import type { BackgroundTokenUsage } from '@rpgspeak/shared';
import { ConversationRepository } from '../../modules/conversations/conversation.repository.js';

const convRepo = new ConversationRepository();

const EMPTY: BackgroundTokenUsage = { prompt: 0, completion: 0, cached: 0, calls: 0, byLabel: {} };

export function readBgUsage(metadata: Record<string, unknown> | null | undefined): BackgroundTokenUsage {
  const raw = (metadata as { bgTokens?: BackgroundTokenUsage } | null | undefined)?.bgTokens;
  if (!raw || typeof raw !== 'object') return { ...EMPTY, byLabel: {} };
  return {
    prompt:     raw.prompt     ?? 0,
    completion: raw.completion ?? 0,
    cached:     raw.cached     ?? 0,
    calls:      raw.calls      ?? 0,
    byLabel:    raw.byLabel    ?? {},
  };
}

/**
 * Registra el consumo de UNA llamada de fondo en el acumulado de la
 * conversación. Nunca lanza: la contabilidad jamás debe tumbar la llamada que
 * está contabilizando.
 */
export function recordBgUsage(
  conversationId: string,
  /** Etiqueta estable del mecanismo (p. ej. 'director-escena', 'resumen-bloque'). */
  label: string,
  tokens: { prompt: number; completion: number; cached?: number } | null | undefined,
): void {
  if (!tokens) return;
  const prompt     = tokens.prompt     || 0;
  const completion = tokens.completion || 0;
  const cached     = tokens.cached     || 0;
  if (prompt === 0 && completion === 0) return;

  try {
    const conv = convRepo.findById(conversationId);
    if (!conv) return;
    const prev = readBgUsage(conv.metadata);
    const prevLabel = prev.byLabel[label] ?? { prompt: 0, completion: 0, cached: 0, calls: 0 };
    const bgTokens: BackgroundTokenUsage = {
      prompt:     prev.prompt     + prompt,
      completion: prev.completion + completion,
      cached:     prev.cached     + cached,
      calls:      prev.calls      + 1,
      byLabel: {
        ...prev.byLabel,
        [label]: {
          prompt:     prevLabel.prompt     + prompt,
          completion: prevLabel.completion + completion,
          cached:     prevLabel.cached     + cached,
          calls:      prevLabel.calls      + 1,
        },
      },
    };
    convRepo.update(conversationId, { metadata: { ...conv.metadata, bgTokens } });
  } catch (err) {
    console.warn(`[bg-tokens] No se pudo registrar el consumo de "${label}":`, err);
  }
}

/** Delta entre dos instantáneas del acumulado (para el coste de un turno). */
export function diffBgUsage(before: BackgroundTokenUsage, after: BackgroundTokenUsage): BackgroundTokenUsage {
  const byLabel: BackgroundTokenUsage['byLabel'] = {};
  for (const [label, a] of Object.entries(after.byLabel)) {
    const b = before.byLabel[label] ?? { prompt: 0, completion: 0, cached: 0, calls: 0 };
    const calls = a.calls - b.calls;
    if (calls > 0) {
      byLabel[label] = {
        prompt:     a.prompt     - b.prompt,
        completion: a.completion - b.completion,
        cached:     a.cached     - b.cached,
        calls,
      };
    }
  }
  return {
    prompt:     after.prompt     - before.prompt,
    completion: after.completion - before.completion,
    cached:     after.cached     - before.cached,
    calls:      after.calls      - before.calls,
    byLabel,
  };
}
