import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Sword, Dices } from 'lucide-react';
import { Modal } from '../ui/Modal.tsx';
import { Button } from '../ui/Button.tsx';
import { Input, Textarea } from '../ui/Input.tsx';
import { conversationsApi } from '../../api/conversations.ts';
import { DICE_DIFFICULTY_LEVELS, effectiveDiceDifficulty } from '@rpgspeak/shared';
import type { PlayerSheet, DiceDifficulty } from '@rpgspeak/shared';

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
  const [form, setForm] = useState<PlayerSheet>(sheet ?? {});
  const [difficulty, setDifficulty] = useState<DiceDifficulty>(
    effectiveDiceDifficulty(diceDifficulty, adventureMode),
  );
  const [newStatKey, setNewStatKey] = useState('');
  const [newStatVal, setNewStatVal] = useState('');
  const [newAbility, setNewAbility] = useState('');
  const [newInventoryItem, setNewInventoryItem] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      await conversationsApi.updatePlayerSheet(conversationId, form);
      return conversationsApi.updateDiceDifficulty(conversationId, difficulty);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      onClose();
    },
  });

  const activeLevel = DICE_DIFFICULTY_LEVELS[difficulty];

  function setField<K extends keyof PlayerSheet>(key: K, value: PlayerSheet[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function addStat() {
    const val = parseFloat(newStatVal);
    if (!newStatKey.trim() || Number.isNaN(val)) return;
    setField('stats', { ...(form.stats ?? {}), [newStatKey.trim()]: val });
    setNewStatKey(''); setNewStatVal('');
  }
  function addAbility() {
    if (!newAbility.trim()) return;
    setField('abilities', [...(form.abilities ?? []), newAbility.trim()]);
    setNewAbility('');
  }
  function addInventoryItem() {
    if (!newInventoryItem.trim()) return;
    setField('inventory', [...(form.inventory ?? []), newInventoryItem.trim()]);
    setNewInventoryItem('');
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Ficha del jugador"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
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
            onChange={(e) => setDifficulty(Number(e.target.value) as DiceDifficulty)}
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
