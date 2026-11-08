import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Sword, Dices } from 'lucide-react';
import { Modal } from '../ui/Modal.tsx';
import { Button } from '../ui/Button.tsx';
import { Input, Textarea } from '../ui/Input.tsx';
import { conversationsApi } from '../../api/conversations.ts';
import { useChatStore } from '../../stores/chat.store.ts';
import { DICE_DIFFICULTY_LEVELS, effectiveDiceDifficulty } from '@rpgspeak/shared';
import type { PlayerSheet, DiceDifficulty, Conversation } from '@rpgspeak/shared';

interface PlayerSheetModalProps {
  conversationId: string;
  sheet: PlayerSheet | null;
  /** Nivel guardado en `conversation.metadata.diceDifficulty` (undefined = sin elegir). */
  diceDifficulty: DiceDifficulty | undefined;
  /** Si alguna historia vinculada es de aventura — solo para saber qué nivel
   *  mostrar cuando el usuario aún no ha elegido ninguno. */
  adventureMode: boolean;
  onClose: () => void;
}

/**
 * Comprueba los mismos límites que `playerSheetSchema` en el servidor. Sin esto,
 * un campo demasiado largo o un número a medio escribir hacía que el PATCH
 * devolviera 400 con un mensaje de zod críptico (o directamente nada).
 */
function validateSheet(f: PlayerSheet): string | null {
  const badNumber = (v: unknown) => v !== undefined && v !== null && !Number.isFinite(v as number);
  if (badNumber(f.level) || badNumber(f.hp) || badNumber(f.maxHp)) {
    return 'Hay un número sin terminar en Nivel, HP o HP máximo.';
  }
  if (f.level !== undefined && (f.level < 1 || f.level > 20)) return 'El nivel debe estar entre 1 y 20.';
  if (f.class && f.class.length > 60) return 'La clase no puede pasar de 60 caracteres.';
  if (f.notes && f.notes.length > 1000) return 'Las notas no pueden pasar de 1000 caracteres.';
  if (f.abilities && f.abilities.length > 30) return 'Máximo 30 habilidades.';
  if (f.abilities?.some((a) => a.length > 100)) return 'Una habilidad no puede pasar de 100 caracteres.';
  if (f.inventory && f.inventory.length > 50) return 'Máximo 50 objetos de inventario.';
  if (f.inventory?.some((i) => i.length > 150)) return 'Un objeto no puede pasar de 150 caracteres.';
  if (f.stats) {
    for (const [k, v] of Object.entries(f.stats)) {
      if (!Number.isFinite(v)) return `El valor de la stat «${k}» no es un número.`;
    }
  }
  return null;
}

/** Deja solo los campos conocidos y con valor útil (recorta, tira los vacíos). */
function sanitizeSheet(f: PlayerSheet): PlayerSheet {
  const out: PlayerSheet = {};
  if (f.class?.trim()) out.class = f.class.trim();
  if (f.level !== undefined) out.level = f.level;
  if (f.hp !== undefined) out.hp = f.hp;
  if (f.maxHp !== undefined) out.maxHp = f.maxHp;
  const stats = { ...(f.stats ?? {}) };
  if (Object.keys(stats).length > 0) out.stats = stats;
  const abilities = (f.abilities ?? []).map((a) => a.trim()).filter(Boolean);
  if (abilities.length > 0) out.abilities = abilities;
  const inventory = (f.inventory ?? []).map((i) => i.trim()).filter(Boolean);
  if (inventory.length > 0) out.inventory = inventory;
  if (f.notes?.trim()) out.notes = f.notes.trim();
  return out;
}

/** Comparación canónica (el orden de claves no cuenta) para verificar la copia
 *  que el servidor devuelve después de guardar. */
function canonical(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, val]) => `${k}:${canonical(val)}`)
      .join(',')}}`;
  }
  return String(v);
}

/**
 * Ficha RPG del jugador para ESTA conversación (no del usuario en general: el
 * mismo jugador puede llevar un mago en una campaña y un guerrero en otra).
 * Mismos campos que la "Ficha RPG" de un personaje — misma forma de dato
 * (RpgStats), misma UX — para que sea instantáneamente familiar.
 *
 * Sin esta ficha, el modelo no tiene ninguna base real contra la que
 * contrastar lo que el jugador dice tener o poder hacer.
 */
export function PlayerSheetModal({ conversationId, sheet, diceDifficulty, adventureMode, onClose }: PlayerSheetModalProps) {
  const qc = useQueryClient();
  // La ficha vive en `conversation.metadata`, y la UI (esta ventana, el combate,
  // el contexto del narrador) la lee del store de chat — NO de una query por id.
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const [form, setForm] = useState<PlayerSheet>(sheet ?? {});
  const [difficulty, setDifficulty] = useState<DiceDifficulty>(
    effectiveDiceDifficulty(diceDifficulty, adventureMode),
  );
  const [newStatKey, setNewStatKey] = useState('');
  const [newStatVal, setNewStatVal] = useState('');
  const [newAbility, setNewAbility] = useState('');
  const [newInventoryItem, setNewInventoryItem] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  // Estado tal y como se abrió la ventana: sirve para detectar cambios sin
  // guardar y no cerrar (X, Escape, toque fuera, botón Cancelar) perdiéndolos.
  const initialSnapshot = useRef(JSON.stringify({ sheet: sheet ?? {}, difficulty }));
  const touchedRef = useRef(false);

  // La ficha puede llegar desfasada al store (otra pestaña, una lista de
  // conversaciones recargada antes de entrar). Al abrir la ventana se pide la
  // versión del servidor: si el usuario todavía no ha tocado nada, esa manda.
  // Sin esto, abrir la ficha vacía y pulsar Guardar sobrescribía en la BD una
  // ficha que sí tenía elementos.
  useEffect(() => {
    let cancelled = false;
    conversationsApi.get(conversationId)
      .then((fresh) => {
        if (cancelled) return;
        setActiveConversation(fresh);
        if (touchedRef.current) return;
        const freshSheet = (fresh.metadata?.playerSheet as PlayerSheet | undefined) ?? null;
        const freshDifficulty = effectiveDiceDifficulty(
          fresh.metadata?.diceDifficulty as DiceDifficulty | undefined,
          adventureMode,
        );
        setForm(freshSheet ?? {});
        setDifficulty(freshDifficulty);
        initialSnapshot.current = JSON.stringify({ sheet: freshSheet ?? {}, difficulty: freshDifficulty });
      })
      .catch(() => { /* sin red o sin respuesta, se sigue usando lo que había en pantalla */ });
    return () => { cancelled = true; };
    // conversationId es la única dependencia real: el resto se lee al abrir.
  }, [conversationId]);

  const mutation = useMutation({
    mutationFn: async () => {
      const problem = validateSheet(form);
      if (problem) throw new Error(problem);
      const sheetToSave = sanitizeSheet(form);

      let saved: Conversation | undefined;
      try {
        saved = await conversationsApi.updatePlayerSheet(conversationId, sheetToSave);
      } catch (err) {
        throw new Error(`No se pudo guardar la ficha — ${err instanceof Error ? err.message : String(err)}`);
      }

      let difficultyResult: Conversation | undefined;
      try {
        difficultyResult = await conversationsApi.updateDiceDifficulty(conversationId, difficulty);
      } catch (err) {
        throw new Error(
          `La ficha se envió, pero falló guardar la dificultad — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const conv = difficultyResult ?? saved;

      // Verificación de verdad: el servidor devuelve la conversación entera, así
      // que se compara su copia con lo que acabamos de enviar. Si no coincide, el
      // guardado NO fue real (ruta de API que cae en el fallback del SPA, proxy
      // que devuelve HTML, instancia distinta…). Sin esta comprobación la ventana
      // se cerraba como si todo hubiera ido bien y al reabrir estaba vacío.
      const echoedSheet = (conv?.metadata?.playerSheet as PlayerSheet | undefined) ?? null;
      const echoedDifficulty = conv?.metadata?.diceDifficulty as DiceDifficulty | undefined;
      if (canonical(echoedSheet) !== canonical(sheetToSave) || echoedDifficulty !== difficulty) {
        throw new Error(
          'El servidor respondió sin la ficha guardada. ' +
          `Enviado: ${canonical(sheetToSave).slice(0, 140)} · Devuelto: ${canonical(echoedSheet).slice(0, 140)}`,
        );
      }
      return conv;
    },
    onSuccess: (updated) => {
      // Refrescar la fuente de verdad real: sin esto, al reabrir la ficha se
      // ve la versión anterior (los elementos "no se guardaron") y el siguiente
      // Guardar sobrescribe en el servidor lo que sí estaba guardado.
      setActiveConversation(updated);
      qc.invalidateQueries({ queryKey: ['conversations'] });
      onClose();
    },
    onError: (err) => {
      // Nunca se deja el mensaje vacío: un error sin texto era exactamente el
      // caso que dejaba al usuario sin saber qué había fallado.
      const message =
        err instanceof Error && err.message.trim()
          ? err.message
          : 'No se pudo guardar la ficha (el servidor no dio detalle).';
      console.error('[player-sheet] Error al guardar:', err);
      setSaveError(message);
    },
  });

  const activeLevel = DICE_DIFFICULTY_LEVELS[difficulty];

  function requestClose() {
    if (mutation.isPending) return;
    const dirty = touchedRef.current || JSON.stringify({ sheet: form, difficulty }) !== initialSnapshot.current;
    if (dirty && !window.confirm('Tienes cambios sin guardar en la ficha. ¿Cerrar sin guardarlos?')) return;
    onClose();
  }

  function setField<K extends keyof PlayerSheet>(key: K, value: PlayerSheet[K]) {
    touchedRef.current = true;
    setForm((f) => ({ ...f, [key]: value }));
    setSaveError(null);
  }

  // Updater funcional en vez de leer `form` del cierre: dos altas seguidas a
  // mucha velocidad (Enter doble) no se pisan entre sí.
  function addStat() {
    const val = parseFloat(newStatVal);
    if (!newStatKey.trim() || Number.isNaN(val)) return;
    const key = newStatKey.trim();
    touchedRef.current = true;
    setForm((f) => ({ ...f, stats: { ...(f.stats ?? {}), [key]: val } }));
    setNewStatKey(''); setNewStatVal('');
  }
  function addAbility() {
    const value = newAbility.trim();
    if (!value) return;
    touchedRef.current = true;
    setForm((f) => ({ ...f, abilities: [...(f.abilities ?? []), value] }));
    setNewAbility('');
  }
  function addInventoryItem() {
    const value = newInventoryItem.trim();
    if (!value) return;
    touchedRef.current = true;
    setForm((f) => ({ ...f, inventory: [...(f.inventory ?? []), value] }));
    setNewInventoryItem('');
  }

  return (
    <Modal
      open
      onClose={requestClose}
      title="Ficha del jugador"
      size="md"
      footer={
        <>
          {saveError && (
            <span className="text-xs text-red-400 mr-auto max-w-[60%]">{saveError}</span>
          )}
          <Button variant="ghost" onClick={requestClose}>Cancelar</Button>
          <Button
            onClick={() => { setSaveError(null); mutation.mutate(); }}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Sword size={14} className="text-accent" />
          <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
            Tu ficha en esta historia
          </span>
        </div>
        <p className="text-xs text-text-muted -mt-2">
          Es la base real contra la que el narrador contrasta lo que dices tener o poder hacer — distinta en cada
          historia, igual que un personaje.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Clase"
            value={form.class ?? ''}
            onChange={(e) => setField('class', e.target.value || undefined)}
            placeholder="Mago"
          />
          <Input
            label="Nivel"
            type="number"
            value={form.level ?? ''}
            onChange={(e) => setField('level', e.target.value ? parseInt(e.target.value, 10) : undefined)}
            min={1}
            max={20}
            placeholder="5"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="HP actual"
            type="number"
            value={form.hp ?? ''}
            onChange={(e) => setField('hp', e.target.value ? parseFloat(e.target.value) : undefined)}
            placeholder="18"
          />
          <Input
            label="HP máximo"
            type="number"
            value={form.maxHp ?? ''}
            onChange={(e) => setField('maxHp', e.target.value ? parseFloat(e.target.value) : undefined)}
            placeholder="30"
          />
        </div>
        <p className="text-xs text-text-muted -mt-2">
          Solo cuenta como punto de partida: en cuanto entres en un combate, el HP en vivo pasa a llevarlo ese
          minijuego.
        </p>

        <div className="space-y-2">
          <label className="text-xs font-medium text-text-secondary">Stats</label>
          <div className="space-y-1">
            {Object.entries(form.stats ?? {}).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2">
                <span className="text-xs font-mono text-accent w-24 truncate">{k}</span>
                <span className="text-xs text-text-secondary flex-1">{v}</span>
                <button
                  onClick={() => {
                    const rest = { ...(form.stats ?? {}) };
                    delete rest[k];
                    setField('stats', rest);
                  }}
                  className="text-text-muted hover:text-red-400"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {Object.keys(form.stats ?? {}).length === 0 && (
              <p className="text-xs text-text-muted italic">Sugerencias: Fuerza, Destreza, Magia, Carisma</p>
            )}
          </div>
          <div className="flex gap-2">
            <input
              value={newStatKey}
              onChange={(e) => setNewStatKey(e.target.value)}
              placeholder="Magia"
              className="flex-1 rounded-lg px-3 py-1.5 text-xs bg-surface-2 border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
            />
            <input
              value={newStatVal}
              onChange={(e) => setNewStatVal(e.target.value)}
              placeholder="14"
              type="number"
              className="w-20 rounded-lg px-3 py-1.5 text-xs bg-surface-2 border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              onClick={addStat}
              className="px-2 py-1.5 rounded-lg text-xs border border-border text-text-muted hover:text-text-primary hover:border-accent/40 transition-colors"
            >
              <Plus size={12} />
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-text-secondary">Habilidades / hechizos conocidos</label>
          <div className="space-y-1">
            {(form.abilities ?? []).map((a, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2">
                <span className="flex-1 text-xs text-text-primary">{a}</span>
                <button
                  onClick={() => setField('abilities', (form.abilities ?? []).filter((_, idx) => idx !== i))}
                  className="text-text-muted hover:text-red-400"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newAbility}
              onChange={(e) => setNewAbility(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addAbility(); }}
              placeholder="ej. Misil Mágico"
              className="flex-1 rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              onClick={addAbility}
              className="px-3 py-2 rounded-lg text-xs border border-border text-text-muted hover:text-text-primary hover:border-accent/40 transition-colors"
            >
              <Plus size={13} />
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-text-secondary">Inventario</label>
          <div className="space-y-1">
            {(form.inventory ?? []).map((item, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2">
                <span className="flex-1 text-xs text-text-primary">{item}</span>
                <button
                  onClick={() => setField('inventory', (form.inventory ?? []).filter((_, idx) => idx !== i))}
                  className="text-text-muted hover:text-red-400"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newInventoryItem}
              onChange={(e) => setNewInventoryItem(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addInventoryItem(); }}
              placeholder="ej. Vara de roble"
              className="flex-1 rounded-lg px-3 py-2 text-sm bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              onClick={addInventoryItem}
              className="px-3 py-2 rounded-lg text-xs border border-border text-text-muted hover:text-text-primary hover:border-accent/40 transition-colors"
            >
              <Plus size={13} />
            </button>
          </div>
        </div>

        <Textarea
          label="Notas de ficha"
          value={form.notes ?? ''}
          onChange={(e) => setField('notes', e.target.value || undefined)}
          placeholder="Trasfondo, condiciones activas, maldiciones..."
          rows={3}
        />

        {/* Ajuste de la partida, no de la ficha — de ahí el separador. */}
        <div className="pt-4 mt-2 border-t border-border space-y-3">
          <div className="flex items-center gap-2">
            <Dices size={14} className="text-accent" />
            <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
              Dificultad de esta conversación
            </span>
          </div>
          <p className="text-xs text-text-muted">
            Cuanto más alta, más probable es que el narrador exija una tirada de dados en lugar de decidir él si tu
            acción sale bien. Solo afecta a esta conversación.
          </p>

          <input
            type="range"
            min={0}
            max={DICE_DIFFICULTY_LEVELS.length - 1}
            step={1}
            value={difficulty}
            onChange={(e) => { touchedRef.current = true; setDifficulty(Number(e.target.value) as DiceDifficulty); }}
            className="w-full accent-accent cursor-pointer"
            aria-label="Dificultad de esta conversación"
          />
          <div className="flex justify-between text-[10px] text-text-muted -mt-1">
            <span>Solo narrativa</span>
            <span>Acciones por tirada</span>
          </div>

          <div className="rounded-lg px-3 py-2 bg-surface-2 border border-border">
            <div className="text-xs font-medium text-accent">{activeLevel.label}</div>
            <div className="text-xs text-text-muted mt-0.5">{activeLevel.hint}</div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
