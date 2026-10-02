import { describe, expect, it } from 'vitest';
import { BookCollector, seedHash } from '../../../tools/books/collector.ts';

// Выборки корзин прообраза книги: в корзине — K раундов с наименьшим хешем сида, редкие — все; итог — функция набора
// сидов, не порядка. Ожидание — перебором: все сиды корзины, отсортированные по хешу.

const CAP = 500_000;

function collect(entries: readonly (readonly [number, number])[], perBucket: number): BookCollector {
  const collector = new BookCollector(CAP, perBucket);
  for (const [seed, payX100] of entries) collector.add(seed, payX100);
  return collector;
}

describe('книга: выборки корзин', () => {
  const entries = Array.from({ length: 50 }, (_, index): [number, number] => [1000 + 37 * index, index % 3 === 0 ? 0 : 95]);

  it('в корзине — K сидов с наименьшим хешем; счёт — все раунды корзины', () => {
    const plain = collect(entries, 4).toPlain();
    const lossSeeds = entries.filter(([, pay]) => pay === 0).map(([seed]) => seed);
    const winSeeds = entries.filter(([, pay]) => pay === 95).map(([seed]) => seed);
    const lowest = (seeds: number[]): number[] => [...seeds].sort((a, b) => seedHash(a) - seedHash(b)).slice(0, 4);
    expect(plain.counts.slice(0, 3)).toStrictEqual([17, 33, 0]);
    expect(plain.samples[0]?.map((item) => item.seed)).toStrictEqual(lowest(lossSeeds));
    expect(plain.samples[1]?.map((item) => item.seed)).toStrictEqual(lowest(winSeeds));
    expect(plain.samples[1]).toHaveLength(4);
    expect(plain.samples[1]?.every((item) => item.payX100 === 95 && item.hash === seedHash(item.seed))).toBe(true);
  });

  it('редкая корзина — все её раунды', () => {
    const plain = collect([[5, 0], [6, 300_000], [7, CAP]], 4).toPlain();
    expect(plain.samples.map((list) => list.length)).toStrictEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  });

  it('слияние не зависит от порядка частей и от того, как сиды разбиты на части', () => {
    const whole = collect(entries, 4).toPlain();
    const first = collect(entries.slice(0, 20), 4).toPlain();
    const second = collect(entries.slice(20), 4).toPlain();
    const ab = new BookCollector(CAP, 4);
    ab.merge(first);
    ab.merge(second);
    const ba = new BookCollector(CAP, 4);
    ba.merge(second);
    ba.merge(first);
    expect(ab.toPlain()).toStrictEqual(whole);
    expect(ba.toPlain()).toStrictEqual(whole);
  });

  it('хеш сида — перестановка: у разных сидов разные хеши', () => {
    const hashes = new Set(Array.from({ length: 10_000 }, (_, seed) => seedHash(seed)));
    expect(hashes.size).toBe(10_000);
    expect(seedHash(0)).not.toBe(0);
  });
});
