import React, { useEffect, useReducer, useRef, useState } from 'react';
import { ChevronLeft, DoorOpen, Package, Sparkles, Swords, X } from 'lucide-react';
import type { Character, PartyState, PlayerSheet, User } from '@rpgspeak/shared';
import { Avatar } from '../ui/Avatar.tsx';
import { battleReducer, buildNarrationPrompt, buildPartyState, computeRewards, createInitialBattleState, type BattleRewards } from '../../lib/battle/engine.ts';
import { applyPartyInventoryState, applyPartyMemberState, createAllyFromCharacter, createPlayerUnit } from '../../lib/battle/party.ts';
import type { BattleDispatchAction, BattleLogEntry, BattleState, BattleUnit } from '../../lib/battle/types.ts';

interface BattleModalProps {
  characters: Character[];
  user: User | null;
  partyState?: PartyState | null;
  /** Ficha del jugador para esta conversación — deriva sus stats de combate,
   *  igual que ya se hace con `character.rpgStats` para los aliados. */
  playerSheet?: PlayerSheet | null;
  onClose: () => void;
  onBattleEnd?: (narrationPrompt: string, outcome: 'victory' | 'defeat' | 'fled', rewards: BattleRewards) => void;
  onPartyStateChange: (partyState: PartyState) => void;
}

export function BattleModal({ characters, user, partyState, playerSheet, onClose, onBattleEnd, onPartyStateChange }: BattleModalProps) {
  const [state, dispatch] = useReducer(battleReducer, undefined, () => {
    const allies = applyPartyMemberState(
      [createPlayerUnit(user, playerSheet), ...characters.slice(0, 3).map(createAllyFromCharacter)],
      partyState,
    );
    const partyLevel = Math.round(allies.reduce((sum, a) => sum + a.level, 0) / allies.length);
    const initial = createInitialBattleState(allies, partyLevel);
    return { ...initial, items: applyPartyInventoryState(initial.items, partyState) };
  });

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [state.log.length]);

  // Pace the enemy turn so each action appears one at a time.
  useEffect(() => {
    if (state.phase !== 'enemy-turn') return;
    const timer = setTimeout(() => dispatch({ type: 'ADVANCE_ENEMY_TURN' }), 900);
    return () => clearTimeout(timer);
  }, [state.phase, state.log.length]);

  const ended = state.phase === 'victory' || state.phase === 'defeat' || state.phase === 'fled';

  // Compute rewards once when victory is reached (uses Math.random, must not re-run)
  const [rewards, setRewards] = useState<BattleRewards | null>(null);
  useEffect(() => {
    if (state.phase === 'victory' && !rewards) setRewards(computeRewards(state));
  }, [state.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleClose() {
    const finalRewards = rewards ?? { xp: 0, gold: 0 };
    onPartyStateChange(buildPartyState(state, partyState, finalRewards));
    if (ended && onBattleEnd) {
      onBattleEnd(
        buildNarrationPrompt(state, finalRewards),
        state.phase as 'victory' | 'defeat' | 'fled',
        finalRewards,
      );
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.75)' }}>
      <div
        className="w-full max-w-3xl rounded-2xl border border-border shadow-2xl flex flex-col animate-slide-up overflow-hidden"
        style={{ background: 'var(--surface-1)', maxHeight: '92vh' }}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Swords size={16} className="text-accent" />
            <p className="font-semibold text-sm">Combate — Ronda {state.round}</p>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-white/8 text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="flex items-stretch gap-3">
            <div className="flex-1 space-y-2 min-w-0">
              <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Aliados</p>
              {state.allies.map((unit) => (
                <UnitCard
                  key={unit.id}
                  unit={unit}
                  active={!ended && state.phase !== 'enemy-turn' && state.allies[state.activeAllyIndex]?.id === unit.id}
                />
              ))}
            </div>

            <div className="flex items-center justify-center px-1 flex-shrink-0">
              <span className="text-xs font-bold text-text-muted opacity-50">VS</span>
            </div>

            <div className="flex-1 space-y-2 min-w-0">
              <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider text-right">Enemigos</p>
              {state.enemies.map((unit) => (
                <UnitCard
                  key={unit.id}
                  unit={unit}
                  reverse
                  selectable={state.phase === 'select-target' && unit.hp > 0}
                  onSelect={() => dispatch({ type: 'CHOOSE_TARGET', targetId: unit.id })}
                />
              ))}
            </div>
          </div>

          <div
            ref={logRef}
            className="rounded-xl border border-border p-3 h-28 overflow-y-auto space-y-1"
            style={{ background: 'var(--surface-2)' }}
          >
            {state.log.map((entry) => <LogLine key={entry.id} entry={entry} />)}
          </div>
        </div>

        <div className="border-t border-border px-5 py-3 flex-shrink-0">
          <ActionPanel state={state} dispatch={dispatch} onClose={handleClose} rewards={rewards} />
        </div>
      </div>
    </div>
  );
}

function UnitCard({ unit, reverse, active, selectable, onSelect }: {
  unit: BattleUnit;
  reverse?: boolean;
  active?: boolean;
  selectable?: boolean;
  onSelect?: () => void;
}) {
  const dead = unit.hp <= 0;
  const hpPct = Math.max(0, (unit.hp / unit.maxHp) * 100);
  const enPct = unit.maxEnergy > 0 ? Math.max(0, (unit.energy / unit.maxEnergy) * 100) : 0;
  const hpColor = hpPct > 50 ? 'bg-emerald-500' : hpPct > 20 ? 'bg-amber-500' : 'bg-red-500';

  const content = (
    <div
      className={`flex items-center gap-2.5 rounded-xl border p-2.5 transition-all ${
        dead ? 'opacity-40 border-border' : active ? 'border-accent bg-accent/5' : 'border-border'
      } ${reverse ? 'flex-row-reverse text-right' : ''}`}
      style={{ background: dead ? undefined : 'var(--surface-2)' }}
    >
      {unit.emoji ? (
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-2xl flex-shrink-0"
          style={{ background: 'var(--surface-3)' }}
          title={unit.description}
        >
          {unit.emoji}
        </div>
      ) : (
        <Avatar name={unit.name} src={unit.avatar} size="md" />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold truncate">{unit.name}{dead ? ' 💀' : ''}</p>
        <div className="h-1.5 rounded-full bg-black/30 mt-1 overflow-hidden">
          <div className={`h-full ${hpColor} transition-all`} style={{ width: `${hpPct}%` }} />
        </div>
        {unit.maxEnergy > 0 && (
          <div className="h-1 rounded-full bg-black/30 mt-1 overflow-hidden">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${enPct}%` }} />
          </div>
        )}
        <p className="text-[9px] text-text-muted mt-0.5 tabular-nums">
          {Math.max(0, unit.hp)}/{unit.maxHp} PV{unit.maxEnergy > 0 ? ` · ${Math.max(0, unit.energy)}/${unit.maxEnergy} EN` : ''}
        </p>
      </div>
    </div>
  );

  if (selectable && onSelect) {
    return (
      <button onClick={onSelect} className="w-full text-left hover:scale-[1.02] active:scale-100 transition-transform">
        {content}
      </button>
    );
  }
  return content;
}

const LOG_COLORS: Record<BattleLogEntry['kind'], string> = {
  info: 'text-text-secondary',
  damage: 'text-red-400',
  crit: 'text-red-300 font-semibold',
  heal: 'text-emerald-400',
  victory: 'text-accent font-semibold',
  defeat: 'text-red-400 font-semibold',
  flee: 'text-amber-400 font-semibold',
};

function LogLine({ entry }: { entry: BattleLogEntry }) {
  return <p className={`text-[11px] leading-snug ${LOG_COLORS[entry.kind]}`}>{entry.text}</p>;
}

function ActionPanel({ state, dispatch, onClose, rewards }: {
  state: BattleState;
  dispatch: React.Dispatch<BattleDispatchAction>;
  onClose: () => void;
  rewards: BattleRewards | null;
}) {
  if (state.phase === 'victory' || state.phase === 'defeat' || state.phase === 'fled') {
    const labels = {
      victory: { icon: '🏆', title: '¡Victoria!', desc: 'El grupo ha vencido a sus enemigos.' },
      defeat: { icon: '☠️', title: 'Derrota', desc: 'El grupo ha caído en combate.' },
      fled: { icon: '🏃', title: 'Huida', desc: 'El grupo ha escapado del combate.' },
    }[state.phase];
    return (
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{labels.icon} {labels.title}</p>
          <p className="text-xs text-text-muted">{labels.desc}</p>
          {rewards && rewards.xp > 0 && (
            <p className="text-xs text-accent font-medium mt-0.5">
              +{rewards.xp} PX &nbsp;·&nbsp; +{rewards.gold} ✦
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="px-4 py-2 rounded-xl text-sm font-medium text-white transition-colors"
          style={{ background: 'var(--accent)' }}
        >
          Cerrar y narrar
        </button>
      </div>
    );
  }

  if (state.phase === 'enemy-turn') {
    return (
      <div className="flex items-center gap-2 text-xs text-text-muted py-2">
        <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
        Turno de los enemigos...
      </div>
    );
  }

  const ally = state.allies[state.activeAllyIndex];

  if (state.phase === 'select-target' || state.phase === 'select-ally-target') {
    if (state.phase === 'select-ally-target') {
      const targets = state.allies.filter((a) => a.hp > 0);
      return (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold">Elige a un aliado</p>
            <BackButton dispatch={dispatch} />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {targets.map((t) => (
              <button
                key={t.id}
                onClick={() => dispatch({ type: 'CHOOSE_TARGET', targetId: t.id })}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs border border-border hover:border-accent/50 hover:bg-accent/5 transition-colors text-left"
              >
                <Avatar name={t.name} src={t.avatar} size="xs" />
                <span className="truncate">{t.name}</span>
              </button>
            ))}
          </div>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-secondary">Elige a un enemigo objetivo...</p>
        <BackButton dispatch={dispatch} />
      </div>
    );
  }

  if (state.phase === 'select-magic') {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold">{ally.name} · Magia</p>
          <BackButton dispatch={dispatch} />
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {ally.abilities.map((a) => (
            <button
              key={a.id}
              disabled={ally.energy < a.energyCost}
              onClick={() => dispatch({ type: 'CHOOSE_ABILITY', abilityId: a.id })}
              className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs border border-border hover:border-accent/50 hover:bg-accent/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-left"
            >
              <span className="truncate">{a.kind === 'heal' ? '✨' : '🔥'} {a.name}</span>
              <span className="text-[10px] text-sky-400 tabular-nums flex-shrink-0">{a.energyCost} EN</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (state.phase === 'select-item') {
    const usable = state.items.filter((i) => i.quantity > 0);
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold">{ally.name} · Objetos</p>
          <BackButton dispatch={dispatch} />
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {usable.map((item) => (
            <button
              key={item.id}
              onClick={() => dispatch({ type: 'CHOOSE_ITEM', itemId: item.id })}
              className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs border border-border hover:border-accent/50 hover:bg-accent/5 transition-colors text-left"
              title={item.description}
            >
              <span className="truncate">🎒 {item.name}</span>
              <span className="text-[10px] text-text-muted tabular-nums flex-shrink-0">x{item.quantity}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold">Turno de {ally.name}</p>
      <div className="grid grid-cols-4 gap-1.5">
        <MenuButton icon={<Swords size={14} />} label="Ataque" onClick={() => dispatch({ type: 'CHOOSE_MENU', menu: 'attack' })} />
        <MenuButton icon={<Sparkles size={14} />} label="Magia" onClick={() => dispatch({ type: 'CHOOSE_MENU', menu: 'magic' })} />
        <MenuButton icon={<Package size={14} />} label="Objetos" onClick={() => dispatch({ type: 'CHOOSE_MENU', menu: 'item' })} />
        <MenuButton icon={<DoorOpen size={14} />} label="Huir" onClick={() => dispatch({ type: 'CHOOSE_MENU', menu: 'flee' })} />
      </div>
    </div>
  );
}

function BackButton({ dispatch }: { dispatch: React.Dispatch<BattleDispatchAction> }) {
  return (
    <button
      onClick={() => dispatch({ type: 'BACK' })}
      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] border border-border text-text-muted hover:text-text-primary transition-colors"
    >
      <ChevronLeft size={11} /> Volver
    </button>
  );
}

function MenuButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1 py-2.5 rounded-xl border border-border hover:border-accent/50 hover:bg-accent/5 transition-colors text-text-secondary hover:text-accent"
    >
      {icon}
      <span className="text-[11px] font-medium">{label}</span>
    </button>
  );
}
