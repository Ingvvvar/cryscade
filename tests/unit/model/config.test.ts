import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { CELL_COUNT, GRID_SIDE, SPOT_MAX_LEVEL } from '../../../src/core/model/grid.ts';
import { PAYING_SYMBOL_COUNT, SCATTER, SYMBOL, SYMBOL_COUNT } from '../../../src/core/model/symbols.ts';

// Таблица §4.4 как в тексте ТЗ — множители ставки строками. Сотые доли считаются из строки,
// а не переписываются руками: опечатка в одном месте не повторится в другом.
const PAYTABLE_4_4: [string, string[]][] = [
  ['Кварц', ['0.95', '3.20', '6.90', '15', '26', '41']],
  ['Аметист', ['0.95', '3.30', '7.90', '19', '36', '63']],
  ['Цитрин', ['0.95', '3.40', '9', '24', '51', '99']],
  ['Изумруд', ['0.95', '3.50', '10', '30', '72', '156']],
  ['Сапфир', ['0.95', '3.60', '12', '37', '101', '244']],
  ['Рубин', ['0.95', '3.70', '13', '47', '143', '382']],
  ['Бриллиант', ['0.95', '3.80', '15', '60', '201', '598']],
];

function x100(multiplier: string): number {
  const [whole = '', fraction = ''] = multiplier.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

describe('DEFAULT_CONFIG против §4.2 и §4.4 (таблица — вариант 4)', () => {
  it.each(PAYTABLE_4_4.map(([name, row], id) => [name, id, row] as const))('%s', (_name, id, row) => {
    expect(DEFAULT_CONFIG.paytableX100[id]).toEqual(row.map(x100));
  });

  it('строк в таблице столько, сколько платящих символов', () => {
    expect(DEFAULT_CONFIG.paytableX100).toHaveLength(7);
  });

  // Форма варианта 4 — условием, а не только литералами: правка одной клетки мимо подбора ловится здесь.
  it('без обрыва: у каждого символа соседние полосы — от ×1.25 до ×4', () => {
    for (const row of DEFAULT_CONFIG.paytableX100) {
      for (let band = 1; band < row.length; band++) {
        const ratio = (row[band] ?? 0) / (row[band - 1] ?? 1);
        expect(ratio, `${String(row[band - 1])} → ${String(row[band])}`).toBeGreaterThanOrEqual(1.25);
        expect(ratio, `${String(row[band - 1])} → ${String(row[band])}`).toBeLessThanOrEqual(4);
      }
    }
  });

  it('ни одной клетки ровно 1.00×, ни одной дороже 1000×; не убывает по полосам, выше 5–6 символы строго дороже', () => {
    const table = DEFAULT_CONFIG.paytableX100;
    expect(table.flat()).not.toContain(100);
    expect(Math.max(...table.flat())).toBeLessThanOrEqual(100_000);
    table.forEach((row, symbol) => {
      row.forEach((value, band) => {
        if (band > 0) expect(value).toBeGreaterThan(row[band - 1] ?? 0);
        const younger = table[symbol - 1]?.[band];
        if (younger === undefined) return;
        if (band === 0) expect(value).toBeGreaterThanOrEqual(younger);
        else expect(value).toBeGreaterThan(younger);
      });
    });
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
