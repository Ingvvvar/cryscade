import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../../src/core/jurisdiction.ts';
import { BIG_WIN, MAX_WIN_CELEBRATE_MS, TIMINGS, bigWinLevel, celebrateMs, counterMs } from '../../../src/core/presentation/timings.ts';

// Тайминги §8.3 и пресеты §11 — литералами из таблиц ТЗ.

describe('тайминги §8.3', () => {
  it('обычный и турбо: сброс, подсветка, взрыв, точки', () => {
    expect([TIMINGS.normal.clearMs, TIMINGS.normal.highlightMs, TIMINGS.normal.explodeMs, TIMINGS.normal.spotsMs]).toStrictEqual([220, 450, 260, 280]);
    expect([TIMINGS.turbo.clearMs, TIMINGS.turbo.highlightMs, TIMINGS.turbo.explodeMs, TIMINGS.turbo.spotsMs]).toStrictEqual([120, 200, 160, 150]);
  });

  it('подсчёт: 300 мс у самого малого выигрыша, 2000 — на 5000×, по логарифму; турбо — вдвое; ноль — подсчёта нет', () => {
    const log = (x: number): number => 300 + (1700 * Math.log10(1 + x)) / Math.log10(5001);
    expect(counterMs(0, 'normal')).toBe(0);
    expect(counterMs(35, 'normal')).toBeCloseTo(log(0.35), 9);
    expect(counterMs(2000, 'normal')).toBeCloseTo(log(20), 9);
    expect(counterMs(500_000, 'normal')).toBeCloseTo(2000, 9);
    expect(counterMs(900_000, 'normal')).toBeCloseTo(2000, 9);
    expect(counterMs(2000, 'turbo')).toBeCloseTo(log(20) / 2, 9);
  });

  it('уровни большого выигрыша: 20×, 50×, 100×, кап', () => {
    expect(BIG_WIN.map((step) => step.fromX100)).toStrictEqual([2000, 5000, 10_000]);
    expect([1999, 2000, 4999, 5000, 9999, 10_000, 499_999].map((pay) => bigWinLevel(pay, false))).toStrictEqual([0, 1, 1, 2, 2, 3, 3]);
    expect(bigWinLevel(500_000, true)).toBe(4);
    expect([celebrateMs(1, 'normal'), celebrateMs(4, 'normal'), celebrateMs(4, 'turbo'), celebrateMs(0, 'normal')]).toStrictEqual([
      2600,
      MAX_WIN_CELEBRATE_MS,
      MAX_WIN_CELEBRATE_MS / 2,
      0,
    ]);
  });
});

describe('пресеты §11', () => {
  it('обычный: автоигра, турбо, пропуск, празднование, цикл 0; строгий — наоборот, цикл 2500, итог на экране', () => {
    expect(PRESETS.standard).toStrictEqual({ autoplay: true, turbo: true, skip: true, minSpinCycleMs: 0, celebrateSmallWins: true, sessionAlwaysVisible: false });
    expect(PRESETS.strict).toStrictEqual({ autoplay: false, turbo: false, skip: false, minSpinCycleMs: 2500, celebrateSmallWins: false, sessionAlwaysVisible: true });
  });
});
