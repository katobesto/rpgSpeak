import { eq, and, desc, asc } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { narrativeThreads, type DbNarrativeThread } from '../../db/schema.js';
import type { NarrativeThread } from '@rpgspeak/shared';
import { v4 as uuidv4 } from 'uuid';

function now() { return new Date().toISOString(); }

function dbToThread(row: DbNarrativeThread): NarrativeThread {
  return {
    id:             row.id,
    conversationId: row.conversationId,
    title:          row.title,
    description:    row.description,
    status:         row.status === 'closed' ? 'closed' : 'open',
    importance:     row.importance,
    openedAtIndex:  row.openedAtIndex,
    closedAtIndex:  row.closedAtIndex,
    createdAt:      row.createdAt,
    updatedAt:      row.updatedAt,
  };
}

/**
 * Clave de identidad de un hilo. Más agresiva que `normalizeCharacterName`
 * porque aquí se comparan FRASES escritas por el modelo, no nombres propios:
 * minúsculas, sin tildes, sin markdown, sin puntuación, sin artículos ni
 * preposiciones sueltas y con los espacios colapsados.
 *
 * Existe para evitar el fallo que haría inútil todo el sistema: el modelo
 * reabriendo el mismo hilo cada turno con una redacción ligeramente distinta
 * ("La promesa a Elías" / "promesa hecha a Elias" / "**Promesa a Elías**")
 * hasta llenar el footer de duplicados del mismo asunto.
 */
export function threadKey(title: string): string {
  return title
    .toLowerCase()
    // NFD separa la tilde de la letra; el rango son los diacríticos combinantes.
    // Deja también la ñ como "n", que para comparar títulos es lo deseable.
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/[^\w\s]/g, ' ')                           // fuera puntuación
    .replace(/\b(el|la|los|las|un|una|unos|unas|de|del|al|a|con|para|por|que|y|o)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ¿Dos títulos designan el mismo hilo? Se aplica en cascada, de más a menos
 * estricto:
 *   1. Clave idéntica.
 *   2. Contención: «promesa» cierra «promesa a Elías».
 *   3. Solapamiento de palabras ≥ 70% sobre el título más corto.
 *
 * El paso 3 es el que salva el caso frecuente de la palabra intercalada
 * («promesa a Elías» vs «promesa hecha a Elías»), que la contención no atrapa
 * y que sin él generaría dos hilos para el mismo asunto. Se exige un mínimo de
 * dos palabras para no fundir títulos de una sola palabra que casualmente
 * coincidan.
 */
export function isSameThread(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  const smaller = ta.size <= tb.size ? ta : tb;
  const larger  = ta.size <= tb.size ? tb : ta;
  if (smaller.size < 2) return false;

  let shared = 0;
  for (const t of smaller) if (larger.has(t)) shared++;
  return shared / smaller.size >= 0.7;
}

export class ThreadRepository {
  private get db() { return getDb(); }

  /** Hilos abiertos, los más importantes primero; a igual importancia, los más antiguos
   *  antes — un hilo viejo sin resolver es justo el que corre peligro de diluirse. */
  findOpen(conversationId: string): NarrativeThread[] {
    return this.db
      .select()
      .from(narrativeThreads)
      .where(and(
        eq(narrativeThreads.conversationId, conversationId),
        eq(narrativeThreads.status, 'open'),
      ))
      .orderBy(desc(narrativeThreads.importance), asc(narrativeThreads.createdAt))
      .all()
      .map(dbToThread);
  }

  /** Todos los hilos (abiertos y cerrados) — para una futura UI de gestión. */
  findByConversation(conversationId: string): NarrativeThread[] {
    return this.db
      .select()
      .from(narrativeThreads)
      .where(eq(narrativeThreads.conversationId, conversationId))
      .orderBy(desc(narrativeThreads.createdAt))
      .all()
      .map(dbToThread);
  }

  /**
   * Abre un hilo, o REFRESCA el que ya existe con el mismo título normalizado.
   *
   * El refresco conserva `openedAtIndex` a propósito: un hilo que el modelo
   * vuelve a mencionar sigue siendo el mismo hilo con la misma antigüedad. Si se
   * reiniciara, un hilo de hace 80 mensajes parecería recién abierto y perdería
   * exactamente la señal de "esto lleva demasiado tiempo sin resolverse".
   */
  open(data: {
    conversationId: string;
    title: string;
    description: string;
    importance: number;
    openedAtIndex: number;
  }): { thread: NarrativeThread; created: boolean } {
    const key = threadKey(data.title);
    const existing = this.findOpen(data.conversationId).find((t) => isSameThread(threadKey(t.title), key));

    if (existing) {
      const ts = now();
      this.db
        .update(narrativeThreads)
        .set({
          // Una descripción nueva y más larga suele traer detalle añadido; una
          // más corta suele ser el modelo resumiendo de memoria. Nos quedamos
          // con la más informativa.
          description: data.description.length > existing.description.length
            ? data.description
            : existing.description,
          importance: Math.max(data.importance, existing.importance),
          updatedAt: ts,
        })
        .where(eq(narrativeThreads.id, existing.id))
        .run();
      return { thread: this.findById(existing.id)!, created: false };
    }

    const id = uuidv4();
    const ts = now();
    this.db.insert(narrativeThreads).values({
      id,
      conversationId: data.conversationId,
      title:          data.title,
      description:    data.description,
      status:         'open',
      importance:     data.importance,
      openedAtIndex:  data.openedAtIndex,
      closedAtIndex:  null,
      createdAt:      ts,
      updatedAt:      ts,
    }).run();
    return { thread: this.findById(id)!, created: true };
  }

  /**
   * Cierra el hilo abierto cuyo título case con `title`. Devuelve el hilo cerrado,
   * o null si ninguno casa.
   *
   * El emparejado es tolerante porque el modelo no reproduce el título literal:
   * clave normalizada, y si falla, contención en un sentido u otro (emitir
   * «la promesa» para cerrar «la promesa a Elías» es lo habitual). Sin esta
   * tolerancia los hilos no se cerrarían nunca y el bloque crecería sin fin.
   */
  close(conversationId: string, title: string, closedAtIndex: number): NarrativeThread | null {
    const key = threadKey(title);
    if (!key) return null;

    const open = this.findOpen(conversationId);
    let match = open.find((t) => threadKey(t.title) === key);

    if (!match) {
      const candidates = open.filter((t) => isSameThread(threadKey(t.title), key));
      // Solo si el emparejado es inequívoco: con varios candidatos no hay forma
      // de saber cuál cerraba y cerrar el que no era pierde el hilo de verdad.
      if (candidates.length === 1) match = candidates[0];
    }
    if (!match) return null;

    const ts = now();
    this.db
      .update(narrativeThreads)
      .set({ status: 'closed', closedAtIndex, updatedAt: ts })
      .where(eq(narrativeThreads.id, match.id))
      .run();
    return this.findById(match.id);
  }

  findById(id: string): NarrativeThread | null {
    const row = this.db.select().from(narrativeThreads).where(eq(narrativeThreads.id, id)).get();
    return row ? dbToThread(row) : null;
  }

  /**
   * Edición manual desde la interfaz: corregir redacción/importancia, o forzar
   * el cierre y la reapertura de un hilo.
   *
   * Va aparte de `close()` a propósito. `close()` es la vía del modelo y empareja
   * por título tolerante — aquí el hilo ya viene identificado por id, así que no
   * hay nada que adivinar. Además `close()` no sabe reabrir, que es justo el caso
   * que la UI necesita cuando el modelo cierra un hilo antes de tiempo.
   *
   * Al reabrir se limpia `closedAtIndex`: si quedara el valor viejo, un hilo
   * reabierto seguiría diciendo en qué mensaje se cerró y la antigüedad que se
   * muestra en el panel dejaría de significar nada.
   */
  update(id: string, data: {
    title?: string;
    description?: string;
    importance?: number;
    status?: 'open' | 'closed';
    closedAtIndex?: number;
  }): NarrativeThread | null {
    const existing = this.findById(id);
    if (!existing) return null;

    const patch: Partial<DbNarrativeThread> = { updatedAt: now() };
    if (data.title       !== undefined) patch.title       = data.title;
    if (data.description !== undefined) patch.description = data.description;
    if (data.importance  !== undefined) patch.importance  = data.importance;

    if (data.status !== undefined && data.status !== existing.status) {
      patch.status = data.status;
      patch.closedAtIndex = data.status === 'closed' ? (data.closedAtIndex ?? existing.openedAtIndex) : null;
    }

    this.db.update(narrativeThreads).set(patch).where(eq(narrativeThreads.id, id)).run();
    return this.findById(id);
  }

  delete(id: string): boolean {
    const res = this.db.delete(narrativeThreads).where(eq(narrativeThreads.id, id)).run();
    return res.changes > 0;
  }
}
