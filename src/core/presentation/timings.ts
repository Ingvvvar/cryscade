// Тайминги показа §8.3 — параметры ощущения одним блоком, правятся на глаз. Миллисекунды. Строгий пресет берёт
// обычную колонку (турбо в нём нет) плюс минимальный цикл из флагов пресета.

export type Speed = 'normal' | 'turbo';

export interface SegmentTimings {
  /** Сброс прежней сетки перед падением новой. */
  readonly clearMs: number;
  readonly highlightMs: number;
  readonly explodeMs: number;
  /** Обновление точек множителей. */
  readonly spotsMs: number;
  /** Множитель длительности подсчёта выигрыша. */
  readonly counterScale: number;
  /** Плашка фичи: появление, показ (у ретриггера и капа), уход. */
  readonly plaqueInMs: number;
  readonly plaqueShowMs: number;
  readonly plaqueOutMs: number;
  /** Множитель длительности празднования большого выигрыша. */
  readonly celebrateScale: number;
}

export const TIMINGS = {
  normal: {
    clearMs: 220,
    highlightMs: 450,
    explodeMs: 260,
    spotsMs: 280,
    counterScale: 1,
    plaqueInMs: 400,
    plaqueShowMs: 700,
    plaqueOutMs: 300,
    celebrateScale: 1,
  },
  turbo: {
    clearMs: 120,
    highlightMs: 200,
    explodeMs: 160,
    spotsMs: 150,
    counterScale: 0.5,
    plaqueInMs: 250,
    plaqueShowMs: 400,
    plaqueOutMs: 200,
    celebrateScale: 0.5,
  },
} as const satisfies Record<Speed, SegmentTimings>;

/** Подсчёт выигрыша: от 300 до 2000 мс по логарифму выигрыша в ставках; 5000× и больше — 2000. */
export const COUNTER_MIN_MS = 300;
export const COUNTER_MAX_MS = 2000;
const COUNTER_TOP_X100 = 500_000;

/** Длительность подсчёта выигрыша payX100 (сотые ставки); ноль — подсчёта нет. */
export function counterMs(payX100: number, speed: Speed): number {
  if (payX100 <= 0) return 0;
  const share = Math.min(1, Math.log10(1 + payX100 / 100) / Math.log10(1 + COUNTER_TOP_X100 / 100));
  return (COUNTER_MIN_MS + (COUNTER_MAX_MS - COUNTER_MIN_MS) * share) * TIMINGS[speed].counterScale;
}

/**
 * Уровни большого выигрыша (§8.4): «Крупный» от 20×, «Огромный» от 50×, «Эпический» от 100×, «Максимум» — раунд дошёл
 * до капа. Длительность празднования — у каждого своя; всё пропускается.
 */
export const BIG_WIN = [
  { level: 1, fromX100: 2000, celebrateMs: 2600 },
  { level: 2, fromX100: 5000, celebrateMs: 3400 },
  { level: 3, fromX100: 10_000, celebrateMs: 4200 },
] as const;
export const MAX_WIN_LEVEL = 4;
export const MAX_WIN_CELEBRATE_MS = 5500;

/** Уровень большого выигрыша: 0 — нет; 4 — кап. */
export function bigWinLevel(payX100: number, capped: boolean): number {
  if (capped) return MAX_WIN_LEVEL;
  let level = 0;
  for (const step of BIG_WIN) if (payX100 >= step.fromX100) level = step.level;
  return level;
}

export function celebrateMs(level: number, speed: Speed): number {
  const base = level === MAX_WIN_LEVEL ? MAX_WIN_CELEBRATE_MS : (BIG_WIN.find((step) => step.level === level)?.celebrateMs ?? 0);
  return base * TIMINGS[speed].celebrateScale;
}

/** Вспышек и пульсаций — не больше трёх в любую секунду (WCAG 2.3.1). */
export const FLASHES_PER_SECOND = 3;
