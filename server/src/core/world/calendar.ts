// ── Reloj del mundo: aritmética de calendario ────────────────────────────────
//
// El tiempo de la partida vive en UN solo número — `worldState.minutesElapsed` —
// y todo lo demás (fecha, día de la semana, estación, fase lunar) se DERIVA aquí
// con funciones puras. Nada de lo derivado se persiste.
//
// Por qué el servidor y no el LLM: pedirle al modelo que mantenga la cabecera
// («07:27 AM, Lunes 14 de Kythorn» + 3h20m = …) es pedirle aritmética de fechas
// turno a turno sobre un estado que solo existe en el texto. Deriva siempre: la
// hora retrocede, el día de la semana deja de cuadrar con la fecha, la estación
// cambia sola. Con un contador y una función pura, la cabecera es incapaz de
// contradecirse — y el modelo solo tiene que decir CUÁNTO tiempo ha pasado, que
// es lo único que él sabe y el servidor no.

import type { StoryCalendar, WorldClock, WorldState } from '@rpgspeak/shared';
import { GREGORIAN_CALENDAR } from '@rpgspeak/shared';

const MINUTES_PER_DAY = 1440;

/** Fases lunares en orden, empezando por luna nueva. */
const MOON_PHASES = [
  'Luna Nueva', 'Creciente Iluminante', 'Cuarto Creciente', 'Gibosa Creciente',
  'Luna Llena', 'Gibosa Menguante', 'Cuarto Menguante', 'Creciente Menguante',
];

/** Franjas del día. Cotas superiores exclusivas, en minutos desde medianoche. */
const DAY_BANDS: Array<{ until: number; label: string }> = [
  { until:  6 * 60, label: 'Madrugada' },
  { until: 12 * 60, label: 'Mañana'    },
  { until: 14 * 60, label: 'Mediodía'  },
  { until: 20 * 60, label: 'Tarde'     },
  { until: 22 * 60, label: 'Anochecer' },
  { until: MINUTES_PER_DAY, label: 'Noche' },
];

/** Días del mes `monthIndex`. Un `daysPerMonth` de un solo elemento se aplica a todos. */
function daysInMonth(cal: StoryCalendar, monthIndex: number): number {
  if (cal.daysPerMonth.length === 0) return 30;
  if (cal.daysPerMonth.length === 1) return cal.daysPerMonth[0];
  return cal.daysPerMonth[monthIndex] ?? cal.daysPerMonth[0];
}

/** Días de un año completo del calendario. */
function daysInYear(cal: StoryCalendar): number {
  if (cal.daysPerMonth.length <= 1) return daysInMonth(cal, 0) * cal.months.length;
  return cal.daysPerMonth.reduce((a, b) => a + b, 0);
}

/** Módulo que devuelve siempre un valor no negativo (`-1 % 7` en JS es `-1`). */
function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Avanza `dayOffset` días desde la fecha de inicio del calendario.
 *  Recorre meses, no días: una campaña de años sigue siendo O(meses). */
function addDays(cal: StoryCalendar, dayOffset: number): { year: number; month: number; day: number } {
  let year  = cal.startYear;
  let month = cal.startMonth;
  let day   = cal.startDay + dayOffset;

  // Saltos de año completos primero, para que una campaña muy larga no itere
  // mes a mes durante miles de vueltas.
  const yearLength = daysInYear(cal);
  if (yearLength > 0 && Math.abs(day) > yearLength) {
    const yearsToSkip = Math.floor((day - 1) / yearLength);
    year += yearsToSkip;
    day  -= yearsToSkip * yearLength;
  }

  while (day > daysInMonth(cal, month)) {
    day -= daysInMonth(cal, month);
    month++;
    if (month >= cal.months.length) { month = 0; year++; }
  }
  while (day < 1) {
    month--;
    if (month < 0) { month = cal.months.length - 1; year--; }
    day += daysInMonth(cal, month);
  }

  return { year, month, day };
}

/** "07:27 AM" — 12 horas con cero a la izquierda, como en la cabecera de referencia. */
function formatTime(minuteOfDay: number): string {
  const h24 = Math.floor(minuteOfDay / 60);
  const min = minuteOfDay % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${String(h12).padStart(2, '0')}:${String(min).padStart(2, '0')} ${suffix}`;
}

/** Deriva todos los valores de la cabecera a partir del estado y el calendario. */
export function computeClock(state: WorldState, calendar: StoryCalendar | null): WorldClock {
  const cal = calendar ?? GREGORIAN_CALENDAR;

  const totalMinutes = cal.startMinuteOfDay + Math.max(0, Math.floor(state.minutesElapsed));
  const dayOffset    = Math.floor(totalMinutes / MINUTES_PER_DAY);
  const minuteOfDay  = mod(totalMinutes, MINUTES_PER_DAY);

  const { year, month, day } = addDays(cal, dayOffset);

  const weekday = cal.weekdays.length > 0
    ? cal.weekdays[mod(cal.startWeekdayIndex + dayOffset, cal.weekdays.length)]
    : '';

  const cycle     = cal.moonCycleDays > 0 ? cal.moonCycleDays : 28;
  const moonDay   = mod(cal.startMoonDay + dayOffset, cycle);
  const moonPhase = MOON_PHASES[Math.floor((moonDay / cycle) * MOON_PHASES.length) % MOON_PHASES.length];

  const monthName = cal.months[month] ?? '';
  const season    = cal.seasons[month] ?? '';

  return {
    timeOfDay: DAY_BANDS.find((b) => minuteOfDay < b.until)?.label ?? 'Noche',
    time:      formatTime(minuteOfDay),
    date:      weekday ? `${weekday}, ${day} de ${monthName}, ${year}` : `${day} de ${monthName}, ${year}`,
    moonPhase,
    season,
    weather:   state.weather,
  };
}

/** Cabecera canónica, en el formato exacto que abre cada respuesta:
 *  `| Mañana | 07:27 AM | Lunes, 14 de Kythorn, 1492 | Luna Llena | Entrada de Sotovento | Primavera | Brisa suave |` */
export function formatHeader(clock: WorldClock, location: string | null | undefined): string {
  const fields = [
    clock.timeOfDay,
    clock.time,
    clock.date,
    clock.moonPhase,
    location?.trim() || 'Lugar sin registrar',
    clock.season,
    clock.weather,
  ];
  return `| ${fields.join(' | ')} |`;
}

/** Estado inicial: SIN anclar. No se imprime cabecera hasta que el modelo declare
 *  la escena con [ESCENA:...] — ver el campo `established` de WorldState. */
export function initialWorldState(): WorldState {
  return { minutesElapsed: 0, weather: 'Cielo despejado', established: false, calendarAnchor: null, updatedAt: new Date().toISOString() };
}

/** Normaliza un worldState leído de la BD. Los guardados antes de existir
 *  `established` se tratan como NO anclados: son justamente los que arrancaron
 *  a cero sobre una conversación ya empezada y muestran una hora falsa. */
export function normalizeWorldState(raw: WorldState | undefined | null): WorldState {
  if (!raw) return initialWorldState();
  return {
    minutesElapsed: Math.max(0, Math.floor(raw.minutesElapsed ?? 0)),
    weather:        raw.weather || 'Cielo despejado',
    established:    raw.established === true,
    calendarAnchor: raw.calendarAnchor ?? null,
    updatedAt:      raw.updatedAt ?? new Date().toISOString(),
  };
}

// ── Ancla de fecha real para historias sin calendario propio ────────────────
//
// GREGORIAN_CALENDAR trae un año/mes/día de FÁBRICA (1 de marzo de 2024) que
// no tiene por qué coincidir con la fecha real en la que arranca cada partida
// nueva. Para una historia "contemporánea" (Story.calendar === null, la
// forma de decir "ambientada en el mundo real, aquí y ahora") el año/mes/día
// deben anclarse a la fecha real del servidor en el momento en que la escena
// se establece — nunca antes (no hay nada que anclar) y nunca recalculado en
// turnos posteriores (el reloj de la partida dejaría de avanzar de forma
// coherente con el paso del tiempo narrado, que es independiente del tiempo
// real que tarda el jugador en escribir el siguiente mensaje).
//
// El modelo NO interviene en esto: la etiqueta [ESCENA:...] solo declara la
// HORA del día (HH:MM), nunca el año — ese dato no está bajo su control ni se
// le pregunta jamás, así que no hay riesgo de que arrastre una fecha de su
// propio corte de entrenamiento.
//
// Las historias con calendario propio (Story.calendar no nulo — fantasía, o
// un año histórico concreto) NUNCA pasan por aquí: su calendario ya define su
// propia fecha de inicio y se respeta siempre tal cual.

/** Fecha real de HOY, en el formato que espera `calendarAnchor`. */
export function todayCalendarAnchor(): NonNullable<WorldState['calendarAnchor']> {
  const now = new Date();
  return {
    year:  now.getFullYear(),
    month: now.getMonth(),       // 0-indexed, igual que StoryCalendar.months
    day:   now.getDate(),
    weekdayIndex: (now.getDay() + 6) % 7,  // JS: 0=domingo → aquí 0=lunes, como StoryCalendar.weekdays
  };
}

/**
 * Calendario EFECTIVO para una conversación concreta.
 * - Historia con calendario propio → se devuelve tal cual, sin tocar.
 * - Historia sin calendario propio y ya anclada (`anchor` presente) → el
 *   gregoriano real, pero con el año/mes/día/día-de-semana de esa ancla.
 * - Historia sin calendario propio y aún sin anclar → el gregoriano de
 *   fábrica (irrelevante en la práctica: sin anclar no se imprime cabecera).
 */
export function resolveEffectiveCalendar(
  storyCalendar: StoryCalendar | null,
  anchor: WorldState['calendarAnchor'] | undefined,
): StoryCalendar {
  if (storyCalendar) return storyCalendar;
  if (!anchor) return GREGORIAN_CALENDAR;
  return {
    ...GREGORIAN_CALENDAR,
    startYear:        anchor.year,
    startMonth:       anchor.month,
    startDay:         anchor.day,
    startWeekdayIndex: anchor.weekdayIndex,
  };
}

// ── Avance del tiempo ────────────────────────────────────────────────────────
//
// El modelo emite [TIEMPO:+45m] / [TIEMPO:+3h] / [TIEMPO:amanecer]. Solo él sabe
// cuánto tiempo consume lo que acaba de narrar; el servidor traduce eso a minutos
// y lo aplica. Los saltos con nombre ("amanecer") se resuelven contra el reloj
// actual para caer siempre en la PRÓXIMA ocurrencia de esa hora.

/** Horas objetivo de los saltos con nombre, en minutos desde medianoche. */
const NAMED_JUMPS: Record<string, number> = {
  amanecer:   6 * 60,
  alba:       6 * 60,
  mañana:     8 * 60,
  mediodia:  12 * 60,
  mediodía:  12 * 60,
  tarde:     15 * 60,
  atardecer: 19 * 60,
  anochecer: 21 * 60,
  noche:     22 * 60,
  medianoche: 0,
};

/** Tope por turno: 30 días. Evita que un [TIEMPO:+9999h] mal emitido mande la
 *  campaña a un futuro del que no hay vuelta atrás. */
const MAX_ADVANCE_MINUTES = 30 * MINUTES_PER_DAY;

/** Sin etiqueta, el tiempo avanza igualmente: una escena de diálogo consume
 *  minutos. Sin esto las conversaciones largas congelan el reloj y el mundo
 *  deja de sentirse vivo. */
export const DEFAULT_ADVANCE_MINUTES = 4;

/**
 * Traduce el valor de una etiqueta [TIEMPO:...] a minutos de avance.
 * Devuelve null si no se reconoce (el llamante aplica el avance por defecto).
 */
export function parseTimeAdvance(raw: string, currentMinuteOfDay: number): number | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  // Duración relativa: +45m, +3h, 2h30m, +1d
  const rel = value.match(/^\+?\s*(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const minutes =
      Number(rel[1] ?? 0) * MINUTES_PER_DAY +
      Number(rel[2] ?? 0) * 60 +
      Number(rel[3] ?? 0);
    return minutes > 0 ? Math.min(minutes, MAX_ADVANCE_MINUTES) : null;
  }

  // Salto con nombre: avanza hasta la próxima vez que el reloj marque esa hora.
  const target = NAMED_JUMPS[value.replace(/^(al|a la|hasta el|hasta la)\s+/, '')];
  if (target !== undefined) {
    const delta = mod(target - currentMinuteOfDay, MINUTES_PER_DAY);
    return delta === 0 ? MINUTES_PER_DAY : delta; // ya estamos en esa hora → día siguiente
  }

  return null;
}

/** Minuto del día actual — necesario para resolver los saltos con nombre. */
export function currentMinuteOfDay(state: WorldState, calendar: StoryCalendar | null): number {
  const cal = calendar ?? GREGORIAN_CALENDAR;
  return mod(cal.startMinuteOfDay + Math.max(0, Math.floor(state.minutesElapsed)), MINUTES_PER_DAY);
}

// ── Corrección de escena ─────────────────────────────────────────────────────
//
// [ESCENA:22:30|dormitorio de Rika] — el modelo declara dónde y cuándo ocurre de
// verdad lo que narra. Es la vía por la que la NARRATIVA corrige al registro,
// no al revés: sin ella, un estado mal sembrado obliga al modelo a estampar una
// cabecera que contradice su propio texto, y no tiene forma de arreglarlo.

/** Interpreta el contenido de [ESCENA:...]. Ambos campos son opcionales. */
export function parseSceneTag(raw: string): { minuteOfDay: number | null; location: string | null } {
  const [timePart, locPart] = raw.split('|');
  const location = locPart?.trim() || null;
  const t = (timePart ?? '').trim().toLowerCase();

  let minuteOfDay: number | null = null;
  // HH:MM en 24h, o con sufijo AM/PM.
  const hm = t.match(/^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/);
  if (hm) {
    let h = Number(hm[1]);
    const m = Number(hm[2]);
    if (hm[3] === 'pm' && h < 12) h += 12;
    if (hm[3] === 'am' && h === 12) h = 0;
    if (h <= 23 && m <= 59) minuteOfDay = h * 60 + m;
  } else if (NAMED_JUMPS[t] !== undefined) {
    // Momento con nombre: "noche", "amanecer"… sirve cuando el modelo no quiere
    // comprometerse con una hora exacta, que es lo habitual al anclar la escena.
    minuteOfDay = NAMED_JUMPS[t];
  }

  return { minuteOfDay, location };
}

/**
 * Devuelve el `minutesElapsed` que sitúa el reloj en `targetMinuteOfDay`.
 *
 * Al ANCLAR se fija esa hora en el día en curso. Al CORREGIR sobre un estado ya
 * anclado se avanza hasta la próxima vez que el reloj marque esa hora, de modo
 * que el tiempo nunca retrocede: rebobinarlo rompería la coherencia de todo lo
 * ya narrado y de los resúmenes que lo referencian.
 */
export function applySceneTime(
  state: WorldState,
  calendar: StoryCalendar | null,
  targetMinuteOfDay: number,
): number {
  const cal = calendar ?? GREGORIAN_CALENDAR;
  if (!state.established) {
    return mod(targetMinuteOfDay - cal.startMinuteOfDay, MINUTES_PER_DAY);
  }
  const delta = mod(targetMinuteOfDay - currentMinuteOfDay(state, calendar), MINUTES_PER_DAY);
  return state.minutesElapsed + delta;
}
