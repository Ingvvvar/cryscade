import { describe, expect, it } from 'vitest';
import { CASCADE_SLOTS } from '../../../src/core/engine/index.ts';
import type { GameConfig } from '../../../src/core/model/config.ts';
import { BUCKETS, bucketOf } from '../../../tools/math/buckets.ts';
import { computeReport, renderMarkdown } from '../../../tools/math/report.ts';
import { AWARD_SLOTS, LEVEL_SLOTS, MAX_CAP_X100, MULT_SLOTS, MathStats, type MathPlain } from '../../../tools/math/stats.ts';
import { TEST_CONFIG } from '../../support/configs.ts';

// Отчёт на литеральном распределении из 11 раундов, кап 10×:
//   0 — 6 раундов, 0.5× — 2, 1× — 1, 1.5× — 1, 10× (кап, фича) — 1.
// Ожидания — ручной расчёт и явно собранная мини-книга, а не формулы отчёта.

const CONFIG: GameConfig = { ...TEST_CONFIG, capX100: 1000 };
const ROUNDS: readonly [payX100: number, count: number][] = [
  [0, 6],
  [50, 2],
  [100, 1],
  [150, 1],
  [1000, 1],
];

function histogram(entries: readonly [number, number][]): Float64Array {
  const result = new Float64Array(CONFIG.capX100 + 1);
  for (const [pay, count] of entries) result[pay] = (result[pay] ?? 0) + count;
  return result;
}

function plainOf(): MathPlain {
  const cells = 2 * 7 * CONFIG.sizeBands.length;
  const usage = new Float64Array(cells);
  usage[6 * 6 + 0] = 2; // основная игра, Бриллиант, полоса 5–6: Σ множителей 2
  return {
    capX100: CONFIG.capX100,
    bands: CONFIG.sizeBands.length,
    rounds: 11,
    total: histogram(ROUNDS),
    // У раунда с капом вся выплата — фича, основная игра дала 0.
    base: histogram([
      [0, 7],
      [50, 2],
      [100, 1],
      [150, 1],
    ]),
    feature: histogram([[1000, 1]]),
    awards: Float64Array.from({ length: AWARD_SLOTS }, (_, spins) => (spins === 10 ? 1 : 0)),
    freeSpins: 12,
    retriggers: 1,
    cascades: new Float64Array(2 * CASCADE_SLOTS),
    maxMult: new Float64Array(MULT_SLOTS),
    maxLevel: new Float64Array(LEVEL_SLOTS),
    usage,
    clusters: new Float64Array(cells),
    usageCapped: new Float64Array(cells),
    requests: 11 * 60,
    longest: { value: 700, seed: 5 },
    top: { value: 1000, seed: 3 },
    batches: [],
  };
}

describe('отчёт на литеральном распределении', () => {
  const report = computeReport(plainOf(), CONFIG);

  it('RTP, частоты, доли', () => {
    expect(report.rtp).toBeCloseTo(1350 / 1100, 12);
    expect(report.winRate).toBeCloseTo(5 / 11, 12);
    expect(report.overBetRate).toBeCloseTo(2 / 11, 12); // 1.5× и 10×; ровно 1× — не больше ставки
    expect(report.smallWinShare).toBeCloseTo(3 / 5, 12);
    expect(report.featureShare).toBeCloseTo(1000 / 1350, 12);
    expect(report.averageFeatureX).toBeCloseTo(10, 12);
    expect(report.spinsPerFeature).toBe(12);
    expect(report.retriggerPerSpin).toBeCloseTo(1 / 12, 12);
    expect(report.caps).toBe(1);
  });

  it('σ — из второго момента, посчитанного по списку раундов', () => {
    const values = ROUNDS.flatMap(([pay, count]) => new Array<number>(count).fill(pay / 100));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    expect(report.sigma).toBeCloseTo(Math.sqrt(variance), 12);
  });

  it('поправка книги сходится с явно собранной мини-книгой', () => {
    // Мини-книга: выигрыши весят по 1, проигрыши — L, и RTP книги ровно 0.96: 13.5 / (5 + L) = 0.96.
    const losing = 13.5 / 0.96 - 5;
    const bookWeight = 5 + losing;
    expect(report.book.feasible).toBe(true);
    expect((report.winRate * report.book.factor)).toBeCloseTo(5 / bookWeight, 12);
    expect(report.overBetRate * report.book.factor).toBeCloseTo(2 / bookWeight, 12);
    expect(report.buckets[0]?.book).toBeCloseTo(losing / bookWeight, 12);
    const secondMoment = (2 * 0.25 + 1 + 2.25 + 100) / bookWeight;
    expect(report.sigmaBook).toBeCloseTo(Math.sqrt(secondMoment - 0.96 ** 2), 12);
  });

  it('корзины: ровно 1× — в (0, 1], 1.5× — в (1, 2), кап — своя корзина', () => {
    const shares = Object.fromEntries(report.buckets.filter((bucket) => bucket.natural > 0).map((bucket) => [bucket.label, bucket.natural]));
    expect(shares).toStrictEqual({ '0': 6 / 11, '(0, 1]': 3 / 11, '(1, 2)': 1 / 11, 'кап': 1 / 11 });
  });

  it('квантили — по накопленной доле', () => {
    expect(report.quantiles.map((item) => [item.q, item.natural])).toStrictEqual([
      [0.5, 0],
      [0.9, 1.5],
      [0.99, 10],
      [0.999, 10],
      [0.9999, 10],
    ]);
  });

  it('вклад клеток таблицы: таблица × Σ множителей / раунды', () => {
    expect(report.contribution[0]?.[6]?.[0]).toBeCloseTo((100 * 2) / (100 * 11), 12);
    expect(report.uncappedRtp).toBeCloseTo(200 / 1100, 12);
  });

  it('ошибка RTP по пакетам: средние пакетов 1× и 3× — ошибка 1×', () => {
    const batch = { rounds: 10, baseX100: 0, featureX100: 0, wins: 0, overBet: 0, features: 0 };
    const withBatches = { ...plainOf(), batches: [{ ...batch, index: 0, payX100: 1000 }, { ...batch, index: 1, payX100: 3000 }] };
    // Средние пакетов 1 и 3: выборочное σ = √2, ошибка среднего = √2 / √2.
    expect(computeReport(withBatches, CONFIG).rtpError).toBeCloseTo(1, 12);
  });

  it('книга невозможна, если после поправки доля выигрышей больше 1', () => {
    const lean = { ...plainOf(), total: histogram([[0, 6], [50, 5]]), feature: histogram([]), rounds: 11 };
    expect(computeReport(lean, CONFIG).book.feasible).toBe(false);
  });

  it('markdown: каждая таблица — отдельный абзац', () => {
    const text = renderMarkdown(report, CONFIG, {
      from: 0,
      threads: 1,
      taskSize: 11,
      maxRequests: 100,
    });
    const lines = text.split('\n');
    const tableStarts = lines.flatMap((line, index) => (line.startsWith('| ') && !(lines[index - 1] ?? '').startsWith('|') ? [index] : []));
    expect(tableStarts.length).toBeGreaterThan(0);
    for (const start of tableStarts) expect(lines[start - 1]).toBe('');
  });
});

describe('корзины §5', () => {
  it.each([
    [0, '0'],
    [1, '(0, 1]'],
    [100, '(0, 1]'],
    [101, '(1, 2)'],
    [199, '(1, 2)'],
    [200, '[2, 5)'],
    [499_999, '[2500, 5000)'],
    [500_000, 'кап'],
  ])('%i при капе 5000× → %s', (pay, label) => {
    expect(BUCKETS[bucketOf(pay, 500_000)]?.label).toBe(label);
  });

  it('при другом капе кап — своя корзина, выше капа выплат нет', () => {
    expect(BUCKETS[bucketOf(2000, 2000)]?.label).toBe('кап');
    expect(BUCKETS[bucketOf(1999, 2000)]?.label).toBe('[10, 20)');
  });
});

describe('сборщик', () => {
  it.each([0, MAX_CAP_X100 + 1, 1.5])('кап %s вне гистограмм — RangeError', (cap) => {
    expect(() => new MathStats(cap, 6)).toThrow(RangeError);
  });
});
