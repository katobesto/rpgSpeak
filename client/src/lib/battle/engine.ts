import type { PartyState } from '@rpgspeak/shared';
import { generateEnemies } from './enemies';
import type { BattleDispatchAction, BattleItem, BattleLogEntry, BattleState, BattleUnit } from './types';

const DEFAULT_ITEMS: BattleItem[] = [
  { id: 'potion', name: 'Poción', description: 'Restaura 40% de los PV', kind: 'heal_hp', amount: 0.4, quantity: 3 },
  { id: 'ether', name: 'Éter', description: 'Restaura 50% de la energía', kind: 'heal_energy', amount: 0.5, quantity: 2 },
  { id: 'elixir', name: 'Elixir', description: 'Restaura PV y energía al máximo', kind: 'heal_full', amount: 1, quantity: 1 },
];

let logCounter = 0;
function makeLog(text: string, kind: BattleLogEntry['kind'] = 'info'): BattleLogEntry {
  logCounter += 1;
  return { id: `log-${logCounter}`, text, kind };
}

export function createInitialBattleState(allies: BattleUnit[], partyLevel: number): BattleState {
  const enemies = generateEnemies(partyLevel);
  return {
    allies,
    enemies,
    items: DEFAULT_ITEMS.map((item) => ({ ...item })),
    log: [
      makeLog(`Aparecen: ${enemies.map((e) => e.name).join(', ')}.`),
      makeLog('¡Comienza el combate!'),
    ],
    round: 1,
    activeAllyIndex: firstAliveIndex(allies, 0),
    phase: 'select-action',
    pendingAction: null,
    actedEnemyIds: new Set(),
  };
}

function firstAliveIndex(units: BattleUnit[], from: number): number {
  for (let i = from; i < units.length; i++) if (units[i].hp > 0) return i;
  return -1;
}

function computeDamage(attacker: BattleUnit, defender: BattleUnit, power: number): { amount: number; crit: boolean } {
  const base = Math.max(1, attacker.attack * power - defender.defense * 0.6);
  const variance = base * (Math.random() * 0.3 - 0.15);
  const crit = Math.random() < 0.1;
  const amount = Math.max(1, Math.round((base + variance) * (crit ? 1.6 : 1)));
  return { amount, crit };
}

function applyDamage(unit: BattleUnit, amount: number): BattleUnit {
  return { ...unit, hp: Math.max(0, unit.hp - amount) };
}

function applyHeal(unit: BattleUnit, amount: number): BattleUnit {
  return { ...unit, hp: Math.min(unit.maxHp, unit.hp + amount) };
}

function pickWeightedTarget(units: BattleUnit[]): BattleUnit {
  const weights = units.map((u) => (1 - u.hp / u.maxHp) + 0.15);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < units.length; i++) {
    r -= weights[i];
    if (r <= 0) return units[i];
  }
  return units[units.length - 1];
}

function checkBattleEnd(state: BattleState): BattleState {
  if (state.enemies.every((e) => e.hp <= 0)) {
    return { ...state, phase: 'victory', log: [...state.log, makeLog('¡Victoria! Los enemigos han sido derrotados.', 'victory')] };
  }
  if (state.allies.every((a) => a.hp <= 0)) {
    return { ...state, phase: 'defeat', log: [...state.log, makeLog('El grupo ha sido derrotado...', 'defeat')] };
  }
  return state;
}

function finishAllyAction(state: BattleState): BattleState {
  const ended = checkBattleEnd(state);
  if (ended.phase !== state.phase) return ended;

  const nextIdx = firstAliveIndex(state.allies, state.activeAllyIndex + 1);
  if (nextIdx === -1) {
    return { ...state, phase: 'enemy-turn', activeAllyIndex: -1, actedEnemyIds: new Set(), pendingAction: null };
  }
  return { ...state, phase: 'select-action', activeAllyIndex: nextIdx, pendingAction: null };
}

function attemptFlee(state: BattleState): BattleState {
  if (Math.random() < 0.6) {
    return { ...state, phase: 'fled', log: [...state.log, makeLog('¡El grupo logra escapar del combate!', 'flee')] };
  }
  return finishAllyAction({ ...state, log: [...state.log, makeLog('¡No se puede escapar!')] });
}

function handleSelectAction(state: BattleState, action: BattleDispatchAction): BattleState {
  if (action.type !== 'CHOOSE_MENU') return state;
  switch (action.menu) {
    case 'attack':
      return { ...state, phase: 'select-target', pendingAction: { source: 'attack' } };
    case 'magic':
      return { ...state, phase: 'select-magic' };
    case 'item':
      if (state.items.every((i) => i.quantity <= 0)) {
        return { ...state, log: [...state.log, makeLog('No quedan objetos utilizables.')] };
      }
      return { ...state, phase: 'select-item' };
    case 'flee':
      return attemptFlee(state);
    default:
      return state;
  }
}

function handleSelectMagic(state: BattleState, action: BattleDispatchAction): BattleState {
  if (action.type === 'BACK') return { ...state, phase: 'select-action' };
  if (action.type !== 'CHOOSE_ABILITY') return state;

  const ally = state.allies[state.activeAllyIndex];
  const ability = ally.abilities.find((a) => a.id === action.abilityId);
  if (!ability) return state;
  if (ally.energy < ability.energyCost) {
    return { ...state, log: [...state.log, makeLog(`${ally.name} no tiene suficiente energía para ${ability.name}.`)] };
  }

  const phase = ability.kind === 'heal' ? 'select-ally-target' : 'select-target';
  return { ...state, phase, pendingAction: { source: 'magic', abilityId: ability.id } };
}

function handleSelectItem(state: BattleState, action: BattleDispatchAction): BattleState {
  if (action.type === 'BACK') return { ...state, phase: 'select-action' };
  if (action.type !== 'CHOOSE_ITEM') return state;

  const item = state.items.find((i) => i.id === action.itemId);
  if (!item || item.quantity <= 0) return state;
  return { ...state, phase: 'select-ally-target', pendingAction: { source: 'item', itemId: item.id } };
}

function handleSelectTarget(state: BattleState, action: BattleDispatchAction): BattleState {
  if (action.type === 'BACK') {
    const source = state.pendingAction?.source;
    const phase = source === 'magic' ? 'select-magic' : source === 'item' ? 'select-item' : 'select-action';
    return { ...state, phase, pendingAction: phase === 'select-action' ? null : state.pendingAction };
  }
  if (action.type !== 'CHOOSE_TARGET') return state;

  const pending = state.pendingAction;
  if (!pending) return state;
  const ally = state.allies[state.activeAllyIndex];

  if (pending.source === 'attack') {
    const enemies = [...state.enemies];
    const idx = enemies.findIndex((e) => e.id === action.targetId);
    if (idx === -1 || enemies[idx].hp <= 0) return state;

    const { amount, crit } = computeDamage(ally, enemies[idx], 1.0);
    enemies[idx] = applyDamage(enemies[idx], amount);
    const logs = [...state.log, makeLog(
      `${ally.name} ataca a ${enemies[idx].name}${crit ? ' — ¡CRÍTICO!' : ''} (-${amount} PV).`,
      crit ? 'crit' : 'damage',
    )];
    if (enemies[idx].hp <= 0) logs.push(makeLog(`${enemies[idx].name} ha sido derrotado.`, 'defeat'));

    return finishAllyAction({ ...state, enemies, log: logs, pendingAction: null });
  }

  if (pending.source === 'magic') {
    const ability = ally.abilities.find((a) => a.id === pending.abilityId);
    if (!ability) return state;

    const allies = [...state.allies];
    allies[state.activeAllyIndex] = { ...allies[state.activeAllyIndex], energy: allies[state.activeAllyIndex].energy - ability.energyCost };

    if (ability.kind === 'heal') {
      const tIdx = allies.findIndex((a) => a.id === action.targetId);
      if (tIdx === -1) return state;
      const amount = Math.round(allies[tIdx].maxHp * ability.power);
      allies[tIdx] = applyHeal(allies[tIdx], amount);
      const logs = [...state.log, makeLog(`${ally.name} usa ${ability.name} sobre ${allies[tIdx].name} (+${amount} PV).`, 'heal')];
      return finishAllyAction({ ...state, allies, log: logs, pendingAction: null });
    }

    const enemies = [...state.enemies];
    const logs = [...state.log];
    if (ability.target === 'all') {
      for (let i = 0; i < enemies.length; i++) {
        if (enemies[i].hp <= 0) continue;
        const { amount, crit } = computeDamage(ally, enemies[i], ability.power);
        enemies[i] = applyDamage(enemies[i], amount);
        logs.push(makeLog(`${ability.name} alcanza a ${enemies[i].name}${crit ? ' — ¡CRÍTICO!' : ''} (-${amount} PV).`, crit ? 'crit' : 'damage'));
        if (enemies[i].hp <= 0) logs.push(makeLog(`${enemies[i].name} ha sido derrotado.`, 'defeat'));
      }
    } else {
      const idx = enemies.findIndex((e) => e.id === action.targetId);
      if (idx === -1 || enemies[idx].hp <= 0) return state;
      const { amount, crit } = computeDamage(ally, enemies[idx], ability.power);
      enemies[idx] = applyDamage(enemies[idx], amount);
      logs.push(makeLog(`${ally.name} usa ${ability.name} sobre ${enemies[idx].name}${crit ? ' — ¡CRÍTICO!' : ''} (-${amount} PV).`, crit ? 'crit' : 'damage'));
      if (enemies[idx].hp <= 0) logs.push(makeLog(`${enemies[idx].name} ha sido derrotado.`, 'defeat'));
    }

    return finishAllyAction({ ...state, allies, enemies, log: logs, pendingAction: null });
  }

  // pending.source === 'item'
  const item = state.items.find((i) => i.id === pending.itemId);
  if (!item || item.quantity <= 0) return state;

  const allies = [...state.allies];
  const tIdx = allies.findIndex((a) => a.id === action.targetId);
  if (tIdx === -1) return state;

  let logText: string;
  if (item.kind === 'heal_hp') {
    const amount = Math.round(allies[tIdx].maxHp * item.amount);
    allies[tIdx] = applyHeal(allies[tIdx], amount);
    logText = `${ally.name} usa ${item.name} en ${allies[tIdx].name} (+${amount} PV).`;
  } else if (item.kind === 'heal_energy') {
    const amount = Math.round(allies[tIdx].maxEnergy * item.amount);
    allies[tIdx] = { ...allies[tIdx], energy: Math.min(allies[tIdx].maxEnergy, allies[tIdx].energy + amount) };
    logText = `${ally.name} usa ${item.name} en ${allies[tIdx].name} (+${amount} energía).`;
  } else {
    allies[tIdx] = { ...allies[tIdx], hp: allies[tIdx].maxHp, energy: allies[tIdx].maxEnergy };
    logText = `${ally.name} usa ${item.name} en ${allies[tIdx].name}. ¡PV y energía al máximo!`;
  }

  const items = state.items.map((i) => (i.id === item.id ? { ...i, quantity: i.quantity - 1 } : i));
  const logs = [...state.log, makeLog(logText, 'heal')];
  return finishAllyAction({ ...state, allies, items, log: logs, pendingAction: null });
}

function resolveEnemyAction(state: BattleState, enemy: BattleUnit): BattleState {
  const aliveAllies = state.allies.filter((a) => a.hp > 0);
  const ability = enemy.abilities[0];

  if (ability?.kind === 'heal' && enemy.energy >= ability.energyCost && enemy.hp / enemy.maxHp < 0.5 && Math.random() < 0.6) {
    const enemies = state.enemies.map((e) => (e.id === enemy.id ? { ...e, energy: e.energy - ability.energyCost } : e));
    const idx = enemies.findIndex((e) => e.id === enemy.id);
    const amount = Math.round(enemies[idx].maxHp * ability.power);
    enemies[idx] = applyHeal(enemies[idx], amount);
    return { ...state, enemies, log: [...state.log, makeLog(`${enemy.name} usa ${ability.name} y recupera ${amount} PV.`, 'heal')] };
  }

  if (ability?.kind === 'damage' && enemy.energy >= ability.energyCost && Math.random() < 0.45) {
    const enemies = state.enemies.map((e) => (e.id === enemy.id ? { ...e, energy: e.energy - ability.energyCost } : e));
    const allies = [...state.allies];
    const logs = [...state.log];

    if (ability.target === 'all') {
      for (let i = 0; i < allies.length; i++) {
        if (allies[i].hp <= 0) continue;
        const { amount, crit } = computeDamage(enemy, allies[i], ability.power);
        allies[i] = applyDamage(allies[i], amount);
        logs.push(makeLog(`${enemy.name} usa ${ability.name} y alcanza a ${allies[i].name}${crit ? ' — ¡CRÍTICO!' : ''} (-${amount} PV).`, crit ? 'crit' : 'damage'));
        if (allies[i].hp <= 0) logs.push(makeLog(`${allies[i].name} ha caído.`, 'defeat'));
      }
    } else {
      const target = pickWeightedTarget(aliveAllies);
      const idx = allies.findIndex((a) => a.id === target.id);
      const { amount, crit } = computeDamage(enemy, allies[idx], ability.power);
      allies[idx] = applyDamage(allies[idx], amount);
      logs.push(makeLog(`${enemy.name} usa ${ability.name} sobre ${allies[idx].name}${crit ? ' — ¡CRÍTICO!' : ''} (-${amount} PV).`, crit ? 'crit' : 'damage'));
      if (allies[idx].hp <= 0) logs.push(makeLog(`${allies[idx].name} ha caído.`, 'defeat'));
    }

    return { ...state, allies, enemies, log: logs };
  }

  const target = pickWeightedTarget(aliveAllies);
  const allies = [...state.allies];
  const idx = allies.findIndex((a) => a.id === target.id);
  const { amount, crit } = computeDamage(enemy, allies[idx], 1.0);
  allies[idx] = applyDamage(allies[idx], amount);
  const logs = [...state.log, makeLog(`${enemy.name} ataca a ${allies[idx].name}${crit ? ' — ¡CRÍTICO!' : ''} (-${amount} PV).`, crit ? 'crit' : 'damage')];
  if (allies[idx].hp <= 0) logs.push(makeLog(`${allies[idx].name} ha caído.`, 'defeat'));
  return { ...state, allies, log: logs };
}

function handleEnemyTurn(state: BattleState, action: BattleDispatchAction): BattleState {
  if (action.type !== 'ADVANCE_ENEMY_TURN') return state;

  const enemy = state.enemies.find((e) => e.hp > 0 && !state.actedEnemyIds.has(e.id));
  if (!enemy) {
    return {
      ...state,
      round: state.round + 1,
      activeAllyIndex: firstAliveIndex(state.allies, 0),
      phase: 'select-action',
      actedEnemyIds: new Set(),
      pendingAction: null,
    };
  }

  const next = resolveEnemyAction(state, enemy);
  const ended = checkBattleEnd(next);
  if (ended.phase !== next.phase) return ended;
  return { ...next, actedEnemyIds: new Set([...next.actedEnemyIds, enemy.id]) };
}

export function battleReducer(state: BattleState, action: BattleDispatchAction): BattleState {
  switch (state.phase) {
    case 'select-action':
      return handleSelectAction(state, action);
    case 'select-magic':
      return handleSelectMagic(state, action);
    case 'select-item':
      return handleSelectItem(state, action);
    case 'select-target':
    case 'select-ally-target':
      return handleSelectTarget(state, action);
    case 'enemy-turn':
      return handleEnemyTurn(state, action);
    default:
      return state;
  }
}

export interface BattleRewards {
  xp: number;
  gold: number;
}

export function computeRewards(state: BattleState): BattleRewards {
  if (state.phase !== 'victory') return { xp: 0, gold: 0 };
  let xp = 0;
  let gold = 0;
  for (const e of state.enemies) {
    const tier = e.maxHp > 100 ? 3 : e.maxHp > 60 ? 2 : e.maxHp > 35 ? 1.5 : 1;
    xp += Math.round(10 * e.level * tier);
    gold += Math.round((5 + Math.random() * 8) * tier);
  }
  return { xp, gold };
}

/** Snapshot of the party's HP/energy, inventory and accumulated rewards for persistence across battles. */
export function buildPartyState(state: BattleState, prev?: PartyState | null, rewards?: BattleRewards): PartyState {
  return {
    members: state.allies.map((a) => ({
      id: a.id,
      name: a.name,
      hp: Math.max(0, a.hp),
      maxHp: a.maxHp,
      energy: Math.max(0, a.energy),
      maxEnergy: a.maxEnergy,
    })),
    inventory: state.items.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity })),
    xp: (prev?.xp ?? 0) + (rewards?.xp ?? 0),
    gold: (prev?.gold ?? 0) + (rewards?.gold ?? 0),
    updatedAt: new Date().toISOString(),
  };
}

export function buildBattleSummary(state: BattleState, rewards?: BattleRewards): string {
  const lines: string[] = ['## Resultado del combate', ''];
  if (state.phase === 'victory') lines.push('El grupo ha derrotado a todos los enemigos.');
  else if (state.phase === 'defeat') lines.push('El grupo ha sido derrotado en combate.');
  else if (state.phase === 'fled') lines.push('El grupo ha escapado del combate.');

  lines.push('', 'Enemigos:');
  for (const e of state.enemies) lines.push(`- ${e.name}: ${Math.max(0, e.hp)}/${e.maxHp} PV${e.hp <= 0 ? ' (derrotado)' : ''}`);

  lines.push('', 'Aliados:');
  for (const a of state.allies) lines.push(`- ${a.name}: ${Math.max(0, a.hp)}/${a.maxHp} PV${a.hp <= 0 ? ' (caído)' : ''}`);

  if (rewards && rewards.xp > 0) {
    lines.push('', `Recompensas: +${rewards.xp} PX · +${rewards.gold} monedas de oro`);
  }

  return lines.join('\n');
}

/** Prompt sent to the LLM after battle ends so it narrates the conclusion in the story. */
export function buildNarrationPrompt(state: BattleState, rewards: BattleRewards): string {
  const outcome =
    state.phase === 'victory' ? 'VICTORIA' :
    state.phase === 'defeat'  ? 'DERROTA'  : 'HUIDA';

  const enemyList = state.enemies.map((e) => e.name).join(', ');
  const fallen = state.allies.filter((a) => a.hp <= 0).map((a) => a.name);
  const survivorsHurt = state.allies.filter((a) => a.hp > 0 && a.hp < a.maxHp * 0.5).map((a) => a.name);

  const highlights = state.log
    .filter((l) => ['crit', 'victory', 'defeat', 'flee'].includes(l.kind))
    .map((l) => `- ${l.text}`)
    .slice(-8)
    .join('\n');

  const rewardLine = rewards.xp > 0
    ? `\nRecompensas obtenidas: ${rewards.xp} PX y ${rewards.gold} monedas de oro.`
    : '';

  return `[COMBATE CONCLUIDO — ${outcome}]
Enemigos: ${enemyList}.
Aliados caídos: ${fallen.length > 0 ? fallen.join(', ') : 'ninguno'}.${survivorsHurt.length > 0 ? `\nHeridos graves: ${survivorsHurt.join(', ')}.` : ''}
Rondas transcurridas: ${state.round}.${rewardLine}

Momentos destacados:
${highlights || '- (combate sin incidentes especiales)'}

Narra en 2-3 párrafos la conclusión de este combate e intégralo en la historia. Describe la acción, el ambiente posterior y las consecuencias inmediatas. Sin listas ni encabezados.`;
}
