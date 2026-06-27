import type { Character, PartyState, User } from '@rpgspeak/shared';
import type { BattleAbility, BattleItem, BattleUnit } from './types';

const PLAYER_LEVEL = 5;

function buildAbilities(signatureMoves: string[] = []): BattleAbility[] {
  const abilities: BattleAbility[] = [];
  if (signatureMoves[0]) {
    abilities.push({ id: 'signature-1', name: signatureMoves[0], energyCost: 6, power: 1.7, kind: 'damage', target: 'single' });
  }
  abilities.push({ id: 'arcane-bolt', name: 'Ráfaga arcana', energyCost: 8, power: 2.0, kind: 'damage', target: 'single' });
  if (signatureMoves[1]) {
    abilities.push({ id: 'signature-2', name: signatureMoves[1], energyCost: 8, power: 1.9, kind: 'damage', target: 'single' });
  }
  abilities.push({ id: 'minor-heal', name: 'Curación menor', energyCost: 6, power: 0.35, kind: 'heal', target: 'single' });
  return abilities;
}

export function createPlayerUnit(user: User | null): BattleUnit {
  return {
    id: 'player',
    name: user?.displayName || 'Tú',
    avatar: user?.avatar ?? null,
    isAlly: true,
    level: PLAYER_LEVEL,
    hp: 60,
    maxHp: 60,
    energy: 30,
    maxEnergy: 30,
    attack: 12,
    defense: 5,
    abilities: buildAbilities(),
  };
}

export function createAllyFromCharacter(character: Character): BattleUnit {
  const rpg = character.rpgStats;
  const level = rpg.level ?? 1;
  const maxHp = rpg.maxHp ?? rpg.hp ?? Math.round(40 + level * 8);
  const hp = Math.min(rpg.hp ?? maxHp, maxHp);

  const statValues = Object.values(rpg.stats ?? {}).filter((v): v is number => typeof v === 'number');
  const avgStat = statValues.length > 0 ? statValues.reduce((a, b) => a + b, 0) / statValues.length : 10;

  const attack = Math.round(6 + avgStat * 0.8 + level * 1.2);
  const defense = Math.round(2 + avgStat * 0.4 + level * 0.6);
  const maxEnergy = Math.round(20 + level * 4);

  return {
    id: character.id,
    name: character.name,
    avatar: character.avatar,
    isAlly: true,
    level,
    hp,
    maxHp,
    energy: maxEnergy,
    maxEnergy,
    attack,
    defense,
    abilities: buildAbilities(rpg.abilities?.slice(0, 2)),
  };
}

/** Merges persisted HP/energy into freshly-derived units, clamped to current max values. */
export function applyPartyMemberState(units: BattleUnit[], partyState?: PartyState | null): BattleUnit[] {
  if (!partyState) return units;
  const byId = new Map(partyState.members.map((m) => [m.id, m]));
  return units.map((unit) => {
    const saved = byId.get(unit.id);
    if (!saved) return unit;
    return {
      ...unit,
      hp: Math.max(0, Math.min(unit.maxHp, saved.hp)),
      energy: Math.max(0, Math.min(unit.maxEnergy, saved.energy)),
    };
  });
}

/** Merges persisted inventory quantities into the default items; unknown ids keep their default quantity. */
export function applyPartyInventoryState(items: BattleItem[], partyState?: PartyState | null): BattleItem[] {
  if (!partyState) return items;
  const byId = new Map(partyState.inventory.map((i) => [i.id, i]));
  return items.map((item) => {
    const saved = byId.get(item.id);
    return saved ? { ...item, quantity: saved.quantity } : item;
  });
}
