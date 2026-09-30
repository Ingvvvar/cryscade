import { describe, expect, it } from 'vitest';
import { MAX_CELL_X100, bandRatios, geometricWeights, isMonotone, maxCellX100, niceTable, niceValueX100, scaledTable } from '../../../tools/math/shape.ts';

describe('веса по ярусам', () => {
  it('поровну: 9930 / 7 = 1418.57 — остаток 4 младшим символам при равных дробных частях', () => {
    expect(geometricWeights(1, 70)).toStrictEqual([1419, 1419, 1419, 1419, 1418, 1418, 1418, 70]);
  });

  it('r = 0.5: доли 5039.37, 2519.69, 1259.84, 629.92, 314.96, 157.48, 78.74 — остаток 5 по наибольшим дробным частям', () => {
    expect(geometricWeights(0.5, 0)).toStrictEqual([5039, 2520, 1260, 630, 315, 157, 79, 0]);
  });

  it('сумма всегда 10 000', () => {
    for (const [ratio, scatter] of [[0.9141, 67], [0.7844, 95], [1.3, 0], [0.61, 333]] as const) {
      expect(geometricWeights(ratio, scatter).reduce((a, b) => a + b, 0)).toBe(10_000);
    }
  });

  it.each([
    [0, 70],
    [0.9, -1],
    [0.9, 10_000],
    [0.9, 7.5],
  ])('r %s, ядро %s — RangeError', (ratio, scatter) => {
    expect(() => geometricWeights(ratio, scatter)).toThrow(RangeError);
  });
});

describe('красивое округление', () => {
  it.each([
    [2, 5],
    [72, 70],
    [73, 75],
    [97.5, 100],
    [150, 150],
    [154, 150],
    [999, 1000],
    [1049, 1000],
    [1050, 1100],
    [36_275, 36_300],
  ])('%s → %s', (value, nice) => {
    expect(niceValueX100(value)).toBe(nice);
  });

  it('при k = 1 черновик §4.4 уже красив', () => {
    expect(niceTable(1)).toStrictEqual([
      [20, 40, 80, 150, 300, 600],
      [25, 50, 100, 200, 400, 800],
      [30, 60, 120, 250, 500, 1000],
      [40, 80, 160, 300, 600, 1200],
      [60, 120, 250, 500, 1000, 2500],
      [80, 160, 350, 700, 1500, 4000],
      [100, 250, 500, 1000, 2500, 10000],
    ]);
  });

  it('дешевеет только полоса 5–6: × m, остальные — черновик × k', () => {
    // Кварц черновика 0.20 / 0.40 / 0.80 / 1.50 / 3 / 6, Бриллиант 1 / 2.50 / 5 / 10 / 25 / 100; k = 10, m = 0.15.
    expect(niceTable(10, 0.15)[0]).toStrictEqual([30, 400, 800, 1500, 3000, 6000]);
    expect(niceTable(10, 0.15)[6]).toStrictEqual([150, 2500, 5000, 10000, 25000, 100000]);
    expect(scaledTable(1.5, 0.5)[6]).toStrictEqual([75, 375, 750, 1500, 3750, 15000]);
  });

  it('самая дорогая клетка и предел 1000×', () => {
    expect(maxCellX100(niceTable(10, 0.15))).toBe(100_000);
    expect(maxCellX100(niceTable(10, 0.15))).toBeLessThanOrEqual(MAX_CELL_X100);
    expect(maxCellX100(niceTable(10.1, 0.15))).toBeGreaterThan(MAX_CELL_X100);
  });

  it('монотонность: по полосам и по ярусам не убывает', () => {
    expect(isMonotone(niceTable(3.6275))).toBe(true);
    expect(isMonotone([[20, 40, 30]])).toBe(false);
    expect(isMonotone([[20, 40], [25, 35]])).toBe(false);
    expect(isMonotone([[20, 40], [20, 40]])).toBe(true);
  });
});

describe('отношения соседних полос (вариант 4: ×1.25…×4)', () => {
  it('таблица варианта 3: наибольшее — обрыв Бриллианта 1.50× → 24×, наименьшее — Кварц 7.60× → 14×', () => {
    const v3 = [
      [30, 380, 760, 1400, 2900, 5700],
      [35, 480, 950, 1900, 3800, 7600],
      [45, 570, 1100, 2400, 4800, 9500],
      [60, 760, 1500, 2900, 5700, 11400],
      [90, 1100, 2400, 4800, 9500, 23800],
      [120, 1500, 3300, 6700, 14300, 38100],
      [150, 2400, 4800, 9500, 23800, 95300],
    ];
    expect(bandRatios(v3)).toStrictEqual({ min: 1400 / 760, max: 2400 / 150 });
  });

  it('ровная строка — ×1', () => {
    expect(bandRatios([[100, 100, 100]])).toStrictEqual({ min: 1, max: 1 });
  });
});
