import type { BattleAbility, BattleUnit } from './types';

interface EnemyTemplate {
  name: string;
  emoji: string;
  description: string;
  hp: number;
  attack: number;
  defense: number;
  energy: number;
  ability?: { name: string; energyCost: number; power: number; kind: 'damage' | 'heal'; target: 'single' | 'all' };
}

const MINIONS: EnemyTemplate[] = [
  { name: 'Rata Carroñera Gigante', emoji: '🐀', description: 'Una rata del tamaño de un perro, con dientes manchados de óxido.', hp: 16, attack: 5, defense: 1, energy: 0 },
  { name: 'Espantapájaros Posesionado', emoji: '🎃', description: 'Paja y trapos animados por una risa que no es la suya.', hp: 20, attack: 6, defense: 2, energy: 0 },
  { name: 'Enjambre de Avispas Espectrales', emoji: '🐝', description: 'Un zumbido translúcido que atraviesa armaduras como si no existieran.', hp: 14, attack: 7, defense: 0, energy: 0 },
  { name: 'Slime Corrosivo', emoji: '🟢', description: 'Una masa gelatinosa que disuelve metal a fuego lento.', hp: 24, attack: 4, defense: 3, energy: 0 },
  { name: 'Cangrejo Acorazado', emoji: '🦀', description: 'Sus pinzas son capaces de partir un escudo de madera de un golpe.', hp: 22, attack: 5, defense: 4, energy: 0 },
];

const NORMALS: EnemyTemplate[] = [
  { name: 'Bandido del Camino Real', emoji: '🗡️', description: 'Conoce cada atajo del bosque y cada punto débil de una armadura.', hp: 34, attack: 9, defense: 3, energy: 10 },
  { name: 'Lobo de Sombra', emoji: '🐺', description: 'Sus ojos brillan como brasas en la oscuridad del bosque.', hp: 38, attack: 10, defense: 2, energy: 10 },
  { name: 'Gólem de Escombros', emoji: '🗿', description: 'Piedra y raíces fusionadas por una magia largo tiempo olvidada.', hp: 52, attack: 8, defense: 6, energy: 0 },
  {
    name: 'Bruja del Pantano', emoji: '🧙‍♀️', description: 'Susurra palabras que pudren el aire a su alrededor.',
    hp: 30, attack: 7, defense: 2, energy: 20,
    ability: { name: 'Brebaje revitalizante', energyCost: 10, power: 0.3, kind: 'heal', target: 'single' },
  },
  { name: 'Caballero Caído', emoji: '💀', description: 'Una armadura vacía que aún recuerda cómo luchar.', hp: 46, attack: 11, defense: 5, energy: 0 },
  {
    name: 'Hidra Juvenil', emoji: '🐍', description: 'Ya tiene dos cabezas, y una tercera empieza a abrirse paso.',
    hp: 50, attack: 10, defense: 3, energy: 12,
    ability: { name: 'Mordisco doble', energyCost: 8, power: 1.4, kind: 'damage', target: 'single' },
  },
];

const ELITES: EnemyTemplate[] = [
  {
    name: 'Quimera Tricéfala', emoji: '🐲', description: 'León, cabra y serpiente compiten por el control de un solo cuerpo.',
    hp: 75, attack: 13, defense: 5, energy: 18,
    ability: { name: 'Aliento abrasador', energyCost: 14, power: 1.1, kind: 'damage', target: 'all' },
  },
  {
    name: 'Vigía Astral', emoji: '👁️', description: 'Un ojo flotante envuelto en runas que reescriben la realidad a su paso.',
    hp: 68, attack: 12, defense: 6, energy: 22,
    ability: { name: 'Velo restaurador', energyCost: 12, power: 0.35, kind: 'heal', target: 'single' },
  },
  { name: 'Verdugo de Hierro', emoji: '⚔️', description: 'Cada golpe de su hacha hace temblar el suelo bajo los pies.', hp: 80, attack: 15, defense: 7, energy: 10 },
];

const BOSSES: EnemyTemplate[] = [
  {
    name: 'Señor de los Huesos', emoji: '☠️', description: 'Un rey olvidado que ahora gobierna un trono hecho de calaveras.',
    hp: 110, attack: 15, defense: 7, energy: 24,
    ability: { name: 'Decreto necrótico', energyCost: 16, power: 0.3, kind: 'heal', target: 'single' },
  },
  {
    name: 'Devorador del Abismo', emoji: '🐙', description: 'Sus tentáculos emergen de una grieta que no debería existir.',
    hp: 130, attack: 17, defense: 8, energy: 20,
    ability: { name: 'Abrazo del vacío', energyCost: 16, power: 1.0, kind: 'damage', target: 'all' },
  },
  {
    name: 'Dragón Carmesí Joven', emoji: '🐉', description: 'Aún no domina su fuego, pero ya basta para incinerar un pueblo entero.',
    hp: 150, attack: 18, defense: 9, energy: 24,
    ability: { name: 'Llamarada', energyCost: 18, power: 1.2, kind: 'damage', target: 'all' },
  },
];

const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

function pickMany<T>(pool: T[], count: number): T[] {
  const result: T[] = [];
  for (let i = 0; i < count; i++) result.push(pool[Math.floor(Math.random() * pool.length)]);
  return result;
}

function instantiate(template: EnemyTemplate, scale: number, suffix: string | undefined, level: number): BattleUnit {
  const abilities: BattleAbility[] = template.ability
    ? [{
        id: 'special',
        name: template.ability.name,
        energyCost: template.ability.energyCost,
        power: template.ability.power,
        kind: template.ability.kind,
        target: template.ability.target,
      }]
    : [];

  const maxHp = Math.round(template.hp * scale);
  const maxEnergy = Math.round(template.energy * scale);

  return {
    id: `enemy-${Math.random().toString(36).slice(2, 9)}`,
    name: suffix ? `${template.name} ${suffix}` : template.name,
    emoji: template.emoji,
    description: template.description,
    isAlly: false,
    level,
    hp: maxHp,
    maxHp,
    energy: maxEnergy,
    maxEnergy,
    attack: Math.round(template.attack * scale),
    defense: Math.round(template.defense * scale),
    abilities,
  };
}

export function generateEnemies(partyLevel: number): BattleUnit[] {
  const scale = 1 + (partyLevel - 1) * 0.15;
  const roll = Math.random();

  let pool: EnemyTemplate[];
  let count: number;
  if (roll < 0.1) {
    pool = BOSSES;
    count = 1;
  } else if (roll < 0.4) {
    pool = [...NORMALS, ...ELITES];
    count = 1 + Math.floor(Math.random() * 2); // 1-2
  } else {
    pool = [...MINIONS, ...NORMALS];
    count = 2 + Math.floor(Math.random() * 2); // 2-3
  }

  const templates = pickMany(pool, count);
  const totals = new Map<string, number>();
  for (const t of templates) totals.set(t.name, (totals.get(t.name) ?? 0) + 1);

  const seen = new Map<string, number>();
  return templates.map((t) => {
    const total = totals.get(t.name)!;
    const idx = (seen.get(t.name) ?? 0) + 1;
    seen.set(t.name, idx);
    return instantiate(t, scale, total > 1 ? ROMAN[idx - 1] : undefined, partyLevel);
  });
}
