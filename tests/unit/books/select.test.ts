import { describe, expect, it } from 'vitest';
import type { BookSample, CollectorPlain } from '../../../tools/books/collector.ts';
import { selectBook } from '../../../tools/books/select.ts';

// Отбор записей книги (§5, шаги 3–4) на прообразе-литерале; у записи (1, 2) сид меньше сидов проигрышей — порядок
// книги по итогу, а не по сиду. Веса посчитаны вручную: единица — 2^16 = 65 536;
// корзина (0, 1] — 3 раунда, сохранён 1: 196 608; (1, 2) — 1 из 1: 65 536; [2, 5) — 8 раундов, сохранено 3:
// round(65 536 × 8 / 3) = round(174 762.67) = 174 763 (вниз было бы 174 762). Σ веса × итог = 196 608 × 95 +
// 65 536 × 190 + 174 763 × 750 = 162 201 850; W = round(162 201 850 / 96) = round(1 689 602.6) = 1 689 603 (вниз —
// 1 689 602); пул проигрышей — W − 786 433 = 903 170, по 451 585 на каждую из двух записей.

const sample = (seed: number, payX100: number, hash = seed): BookSample => ({ hash, seed, payX100 });
const counts = (values: Record<number, number>): number[] => Array.from({ length: 14 }, (_, bucket) => values[bucket] ?? 0);
const samples = (values: Record<number, readonly BookSample[]>): BookSample[][] => Array.from({ length: 14 }, (_, bucket) => [...(values[bucket] ?? [])]);

const PROTOTYPE: CollectorPlain = {
  counts: counts({ 0: 6, 1: 3, 2: 1, 3: 8 }),
  samples: samples({
    0: [sample(11, 0), sample(10, 0)],
    1: [sample(20, 95)],
    2: [sample(5, 190)],
    3: [sample(42, 300), sample(40, 200), sample(41, 250)],
  }),
};

const withLosses = (seeds: readonly number[]): CollectorPlain => ({
  ...PROTOTYPE,
  samples: PROTOTYPE.samples.map((list, bucket) => (bucket === 0 ? seeds.map((seed) => sample(seed, 0)) : list)),
});

describe('книга: отбор записей', () => {
  it('веса корзин, пул проигрышей и порядок по итогу, потом по сиду — литералы', () => {
    const book = selectBook(PROTOTYPE);
    expect(book.records).toStrictEqual([
      { seed: 10, payX100: 0, weight: 451_585 },
      { seed: 11, payX100: 0, weight: 451_585 },
      { seed: 20, payX100: 95, weight: 196_608 },
      { seed: 5, payX100: 190, weight: 65_536 },
      { seed: 40, payX100: 200, weight: 174_763 },
      { seed: 41, payX100: 250, weight: 174_763 },
      { seed: 42, payX100: 300, weight: 174_763 },
    ]);
    expect([book.paid, book.total]).toStrictEqual([162_201_850n, 1_689_603n]);
  });

  it('RTP книги — 0.96 с точностью до половины единицы веса: Σ веса × итог − 96 × W = −38', () => {
    const book = selectBook(PROTOTYPE);
    expect(book.paid - 96n * book.total).toBe(-38n);
  });

  it('остаток пула проигрышей — по единице первым записям по сиду', () => {
    // Три записи: 903 170 = 3 × 301 056 + 2 — лишние единицы у двух первых.
    expect(selectBook(withLosses([12, 10, 11])).records.slice(0, 3)).toStrictEqual([
      { seed: 10, payX100: 0, weight: 301_057 },
      { seed: 11, payX100: 0, weight: 301_057 },
      { seed: 12, payX100: 0, weight: 301_056 },
    ]);
    // Пять записей: 903 170 = 5 × 180 634 — поровну.
    expect(selectBook(withLosses([14, 13, 12, 11, 10])).records.slice(0, 5).map((record) => record.weight)).toStrictEqual([
      180_634, 180_634, 180_634, 180_634, 180_634,
    ]);
  });

  it('без проигрышей — ошибка; вес записи вне u32 — ошибка', () => {
    expect(() => selectBook({ counts: counts({ 1: 3 }), samples: samples({ 1: [sample(20, 95)] }) })).toThrow(RangeError);
    expect(() => selectBook({ counts: counts({ 0: 1, 1: 70_000 }), samples: samples({ 0: [sample(1, 0)], 1: [sample(20, 95)] }) })).toThrow(RangeError);
  });
});
