import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FALL,
  bounceCeiling,
  columnStartMs,
  fallHeight,
  gridSettleMs,
  settleMs,
  type FallProfile,
} from '../../../src/core/presentation/fall.ts';
import { scanAllocations } from '../engine/alloc-scan.ts';

// Литералы посчитаны руками. Профиль: касание 400 мс, e = 0.25, два отскока; старт с высоты 300.
// g = 2·300/400² = 0.00375 ед/мс²; скорость удара 1.5 ед/мс.
// Отскок 1: отрыв 0.375, длится 2·0.375/g = 200 мс, пик в 500 мс — e²·300 = 18.75.
// Отскок 2: отрыв 0.09375, длится 50 мс, пик в 625 мс — e⁴·300 = 1.171875. Покой с 650 мс.
const HAND: FallProfile = { touchMs: 400, restitution: 0.25, bounces: 2, columnDelayMs: 45 };

describe('fallHeight — литералы', () => {
  it('до старта и в старт — высота старта', () => {
    expect(fallHeight(HAND, 300, -5)).toBe(300);
    expect(fallHeight(HAND, 300, 0)).toBe(300);
  });

  it('на половине пути по времени пройдена четверть высоты', () => {
    expect(fallHeight(HAND, 300, 200)).toBe(225);
  });

  it('касание ровно в клетке ровно в расчётный момент', () => {
    expect(fallHeight(HAND, 300, 400)).toBe(0);
    expect(fallHeight(HAND, 300, 399.999)).toBeGreaterThan(0);
  });

  it('пики отскоков: e² и e⁴ от высоты старта', () => {
    expect(fallHeight(HAND, 300, 500)).toBeCloseTo(18.75, 9);
    expect(fallHeight(HAND, 300, 600)).toBeCloseTo(0, 9);
    expect(fallHeight(HAND, 300, 625)).toBeCloseTo(1.171875, 9);
  });

  it('после последнего отскока — покой, ровно ноль', () => {
    expect(settleMs(HAND)).toBeCloseTo(650, 9);
    expect(fallHeight(HAND, 300, 650.001)).toBe(0);
    expect(fallHeight(HAND, 300, 10_000)).toBe(0);
  });

  it('потолок отскока — e² от высоты старта', () => {
    expect(bounceCeiling(HAND, 300)).toBe(18.75);
  });

  it('колонки стартуют через задержку; последняя успокаивается через 6 задержек', () => {
    expect(columnStartMs(HAND, 0)).toBe(0);
    expect(columnStartMs(HAND, 6)).toBe(270);
    expect(gridSettleMs(HAND)).toBeCloseTo(920, 9);
  });

  it('без отскоков касание сразу даёт покой', () => {
    const flat: FallProfile = { touchMs: 400, restitution: 0, bounces: 0, columnDelayMs: 20 };
    expect(fallHeight(flat, 300, 400)).toBe(0);
    expect(fallHeight(flat, 300, 401)).toBe(0);
    expect(settleMs(flat)).toBe(400);
    expect(bounceCeiling(flat, 300)).toBe(0);
  });
});

describe('профили', () => {
  const profiles = Object.entries(FALL);

  it('профилей больше нуля, и каждый в своих границах', () => {
    expect(profiles.length).toBeGreaterThan(0);
    for (const [name, profile] of profiles) {
      expect(profile.touchMs, name).toBeGreaterThan(0);
      expect(profile.restitution, name).toBeGreaterThanOrEqual(0);
      expect(profile.restitution, name).toBeLessThan(1);
      expect(Number.isInteger(profile.bounces), name).toBe(true);
      expect(profile.bounces, name).toBeGreaterThanOrEqual(0);
    }
  });

  it('задержки колонок — из таблицы §8.3: обычный 45, турбо 20', () => {
    expect(FALL.normal.columnDelayMs).toBe(45);
    expect(FALL.turbo.columnDelayMs).toBe(20);
  });

  it('reduced motion: падение короче обычного и без отскока', () => {
    expect(FALL.reduced.touchMs).toBeLessThan(FALL.normal.touchMs);
    expect(FALL.reduced.bounces).toBe(0);
    expect(fallHeight(FALL.reduced, 700, FALL.reduced.touchMs + 1)).toBe(0);
  });
});

const profileArb = fc.record({
  touchMs: fc.double({ min: 20, max: 2000, noNaN: true }),
  restitution: fc.double({ min: 0, max: 0.6, noNaN: true }),
  bounces: fc.integer({ min: 0, max: 4 }),
  columnDelayMs: fc.constant(45),
});
const distanceArb = fc.double({ min: 1, max: 3000, noNaN: true });

describe('fallHeight — свойства', () => {
  it('касание ровно в touchMs на любом профиле', () => {
    fc.assert(fc.property(profileArb, distanceArb, (profile, distance) => fallHeight(profile, distance, profile.touchMs) === 0));
  });

  it('до касания движение монотонно и не выходит из (0, distance]', () => {
    fc.assert(
      fc.property(profileArb, distanceArb, fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (profile, distance, a, b) => {
        const t1 = Math.min(a, b) * profile.touchMs;
        const t2 = Math.max(a, b) * profile.touchMs;
        const h1 = fallHeight(profile, distance, t1);
        const h2 = fallHeight(profile, distance, t2);
        const inside = (t: number, h: number): boolean => t <= 0 || t >= profile.touchMs || (h > 0 && h <= distance);
        return h1 >= h2 && inside(t1, h1) && inside(t2, h2);
      }),
    );
  });

  it('после касания отскок в границах [0, e²·distance]', () => {
    fc.assert(
      fc.property(profileArb, distanceArb, fc.double({ min: 0, max: 3, noNaN: true }), (profile, distance, share) => {
        const h = fallHeight(profile, distance, profile.touchMs * (1 + share));
        return h >= 0 && h <= bounceCeiling(profile, distance) * (1 + 1e-12);
      }),
    );
  });

  it('с момента покоя — ровно ноль', () => {
    fc.assert(
      fc.property(profileArb, distanceArb, fc.double({ min: 0, max: 5000, noNaN: true }), (profile, distance, extra) => {
        const settle = settleMs(profile);
        return fallHeight(profile, distance, settle * (1 + 1e-9) + 1e-9 + extra) === 0;
      }),
    );
  });
});

describe('падение без аллокаций', () => {
  const file = 'src/core/presentation/fall.ts';
  const text = readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), 'utf8');
  const scan = scanAllocations(file, text);

  it('скан нашёл функции падения', () => {
    expect(scan.functions).toEqual(expect.arrayContaining(['fallHeight', 'settleMs', 'bounceCeiling', 'columnStartMs', 'gridSettleMs']));
  });

  it('аллокаций нет', () => {
    expect(scan.findings).toStrictEqual([]);
  });
});
