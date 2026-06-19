export interface BattleAbility {
  id: string;
  name: string;
  energyCost: number;
  /** Damage abilities: multiplier applied to attack. Heal abilities: fraction of maxHp restored. */
  power: number;
  kind: 'damage' | 'heal';
  target: 'single' | 'all';
}

export interface BattleUnit {
  id: string;
  name: string;
  avatar?: string | null;
  emoji?: string;
  description?: string;
  isAlly: boolean;
  level: number;
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
  attack: number;
  defense: number;
  abilities: BattleAbility[];
}

export interface BattleItem {
  id: string;
  name: string;
  description: string;
  kind: 'heal_hp' | 'heal_energy' | 'heal_full';
  /** Fraction (0-1) of the relevant max stat restored. Ignored for heal_full. */
  amount: number;
  quantity: number;
}

export type BattleLogKind = 'info' | 'damage' | 'crit' | 'heal' | 'victory' | 'defeat' | 'flee';

export interface BattleLogEntry {
  id: string;
  text: string;
  kind: BattleLogKind;
}

export type BattlePhase =
  | 'select-action'
  | 'select-magic'
  | 'select-item'
  | 'select-target'
  | 'select-ally-target'
  | 'enemy-turn'
  | 'victory'
  | 'defeat'
  | 'fled';

export interface PendingAction {
  source: 'attack' | 'magic' | 'item';
  abilityId?: string;
  itemId?: string;
}

export interface BattleState {
  allies: BattleUnit[];
  enemies: BattleUnit[];
  items: BattleItem[];
  log: BattleLogEntry[];
  round: number;
  activeAllyIndex: number;
  phase: BattlePhase;
  pendingAction: PendingAction | null;
  actedEnemyIds: Set<string>;
}

export type BattleDispatchAction =
  | { type: 'CHOOSE_MENU'; menu: 'attack' | 'magic' | 'item' | 'flee' }
  | { type: 'CHOOSE_ABILITY'; abilityId: string }
  | { type: 'CHOOSE_ITEM'; itemId: string }
  | { type: 'CHOOSE_TARGET'; targetId: string }
  | { type: 'BACK' }
  | { type: 'ADVANCE_ENEMY_TURN' };
