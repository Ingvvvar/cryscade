import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { CELL_COUNT, GRID_SIDE, SPOT_MAX_LEVEL } from '../../../src/core/model/grid.ts';
import { PAYING_SYMBOL_COUNT, SCATTER, SYMBOL, SYMBOL_COUNT } from '../../../src/core/model/symbols.ts';

// Таблица §4.4 как в тексте ТЗ — множители ставки строками. Сотые доли считаются из строки,
// а не переписываются руками: опечатка в одном месте не повторится в другом.
const PAYTABLE_4_4: [string, string[]][] = [
  ['Кварц', ['0.70', '1.40', '2.90', '5.40', '11', '22']],
  ['Аметист', ['0.90', '1.80', '3.60', '7.20', '14', '29']],
  ['Цитрин', ['1.10', '2.20', '4.30', '9.10', '18', '36']],
  ['Изумруд', ['1.40', '2.90', '5.80', '11', '22', '43']],
  ['Сапфир', ['2.20', '4.30', '9.10', '18', '36', '91']],
  ['Рубин', ['2.90', '5.80', '13', '25', '54', '145']],
  ['Бриллиант', ['3.60', '9.10', '18', '36', '91', '362']],
];

function x100(multiplier: string): number {
  const [whole = '', fraction = ''] = multiplier.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

describe('DEFAULT_CONFIG против §4.2 и §4.4 (итог фазы 2)', () => {
  it.each(PAYTABLE_4_4.map(([name, row], id) => [name, id, row] as const))('%s', (_name, id, row) => {
    expect(DEFAULT_CONFIG.paytableX100[id]).toEqual(row.map(x100));
  });

  it('строк в таблице столько, сколько платящих символов', () => {
    expect(DEFAULT_CONFIG.paytableX100).toHaveLength(7);
  });

  it('полосы 5–6, 7–8, 9–10, 11–12, 13–14, 15+; кластер от 5', () => {
    expect(DEFAULT_CONFIG.sizeBands).toEqual([5, 7, 9, 11, 13, 15]);
    expect(DEFAULT_CONFIG.clusterMin).toBe(5);
  });

  it('ядра 3 / 4 / 5 / 6+ → 10 / 12 / 15 / 20; ретриггер 3+ → ещё 5', () => {
    expect(DEFAULT_CONFIG.freeSpinsByScatters).toEqual([0, 0, 0, 10, 12, 15, 20]);
    expect(DEFAULT_CONFIG.retrigger).toEqual({ min: 3, add: 5 });
  });

  it('кап 5000× ставки', () => {
    expect(DEFAULT_CONFIG.capX100).toBe(5000 * 100);
  });

  // Значения весов подбирает фаза 2 — здесь только форма.
  it.each(['base', 'free'] as const)('веса %s: 8 неотрицательных целых, ядро выпадает, сумма в u32', (mode) => {
    const weights = DEFAULT_CONFIG.weights[mode];
    expect(weights).toHaveLength(8);
    for (const w of weights) expect(Number.isSafeInteger(w) && w >= 0, String(w)).toBe(true);
    expect(weights[7]).toBeGreaterThan(0);
    const total = weights.reduce((sum, w) => sum + w, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(2 ** 32);
  });
});

describe('символы и сетка §4.1, §4.7', () => {
  it('id символов', () => {
    expect(SYMBOL).toEqual({ quartz: 0, amethyst: 1, citrine: 2, emerald: 3, sapphire: 4, ruby: 5, diamond: 6, core: 7 });
    expect(SCATTER).toBe(7);
    expect(SYMBOL_COUNT).toBe(8);
    expect(PAYING_SYMBOL_COUNT).toBe(7);
  });

  it('сетка 7×7, верхний уровень точки — ×128', () => {
    expect(GRID_SIDE).toBe(7);
    expect(CELL_COUNT).toBe(49);
    expect(2 ** (SPOT_MAX_LEVEL - 1)).toBe(128);
  });
});
