// Аналитическое падение §8.3. Колонка стартует без скорости и падает с постоянным ускорением так, что касается
// точки покоя ровно в touchMs; затем отскоки: скорость отрыва — restitution от скорости удара, поэтому высота
// каждого следующего отскока — restitution² от прошлой. После последнего отскока — покой.
// Высота — над точкой покоя, в единицах дизайна; время — миллисекунды от старта колонки. Без аллокаций.

import { GRID_SIDE } from '../model/grid.ts';

export interface FallProfile {
  /** От старта до касания, мс. */
  readonly touchMs: number;
  /** Доля скорости удара, с которой символ отрывается; 0 — без отскока. Меньше 1. */
  readonly restitution: number;
  /** Сколько отскоков до покоя. */
  readonly bounces: number;
  /** Задержка между соседними колонками, мс. */
  readonly columnDelayMs: number;
}

/** Параметры ощущения — правятся на глаз; задержки колонок — из таблицы §8.3. */
export const FALL = {
  normal: { touchMs: 380, restitution: 0.22, bounces: 2, columnDelayMs: 45 },
  turbo: { touchMs: 220, restitution: 0.18, bounces: 1, columnDelayMs: 20 },
  /** prefers-reduced-motion (§8.4): короче и без отскока. */
  reduced: { touchMs: 200, restitution: 0, bounces: 0, columnDelayMs: 20 },
} as const satisfies Record<string, FallProfile>;

/** Высота над точкой покоя в момент tMs; distance — высота старта. До старта — distance, в touchMs — ровно 0. */
export function fallHeight(profile: FallProfile, distance: number, tMs: number): number {
  const touch = profile.touchMs;
  if (tMs <= 0) return distance;
  if (tMs < touch) {
    const k = tMs / touch;
    return distance * (1 - k * k);
  }
  // Ускорение g = 2·distance / touch², скорость удара — g·touch.
  let speed = (2 * distance) / touch;
  const gravity = speed / touch;
  let tau = tMs - touch;
  for (let bounce = 0; bounce < profile.bounces; bounce++) {
    speed *= profile.restitution;
    const duration = (2 * speed) / gravity;
    if (tau < duration) return Math.max(0, tau * (speed - 0.5 * gravity * tau));
    tau -= duration;
  }
  return 0;
}

/** Высшая точка отскоков над покоем: restitution² от высоты старта. */
export function bounceCeiling(profile: FallProfile, distance: number): number {
  return profile.bounces > 0 ? profile.restitution * profile.restitution * distance : 0;
}

/** От старта колонки до покоя, мс: касание плюс длительности всех отскоков. */
export function settleMs(profile: FallProfile): number {
  let total = profile.touchMs;
  let share = 1;
  for (let bounce = 0; bounce < profile.bounces; bounce++) {
    share *= profile.restitution;
    total += 2 * share * profile.touchMs;
  }
  return total;
}

/** Старт колонки column (0 — левая), мс. */
export function columnStartMs(profile: FallProfile, column: number): number {
  return column * profile.columnDelayMs;
}

/** Вся сетка в покое: последняя колонка стартовала и успокоилась. */
export function gridSettleMs(profile: FallProfile): number {
  return columnStartMs(profile, GRID_SIDE - 1) + settleMs(profile);
}
