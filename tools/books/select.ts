import type { BookRecord } from '../../src/server/book.ts';
import type { CollectorPlain } from './collector.ts';

// Записи книги из прообраза (§5, шаги 3–4). Вес записи выигрышной корзины — её доля в прообразе, делённая на число
// сохранённых, в целых: round(WEIGHT_UNIT × N_b / k_b); у редкой корзины (сохранены все) — ровно WEIGHT_UNIT. Проигрыши —
// один пул: его сумма весов делает RTP книги ровно 0.96 до округления одной единицы веса — Σ веса × итог / (100 × W),
// всё в BigInt. Порядок — по итогу, потом по сиду: максимальный выигрыш книги — последние индексы.

/** Единица веса на раунд прообраза: 2^16 — вес записи проигрыша и самой частой корзины влезает в u32. */
export const WEIGHT_UNIT = 65_536;
/** RTP книги — 96/100 точно. */
const RTP_NUMERATOR = 96n;

export interface SelectedBook {
  readonly records: readonly BookRecord[];
  /** Σ веса × payX100 и Σ весов — RTP = sum / (100 × total). */
  readonly paid: bigint;
  readonly total: bigint;
}

const U32_MAX = 0xffff_ffff;

export function selectBook(prototype: CollectorPlain): SelectedBook {
  const [lossCount = 0, ...winCounts] = prototype.counts;
  const losses = prototype.samples[0] ?? [];
  if (lossCount < 1 || losses.length < 1) throw new RangeError('в прообразе нет проигрышей — пул проигрышей пуст');
  const wins: BookRecord[] = [];
  winCounts.forEach((count, index) => {
    const samples = prototype.samples[index + 1] ?? [];
    if (samples.length === 0) return;
    // round(UNIT × N / k) в целых: (2 × UNIT × N + k) / (2k), вниз.
    const k = BigInt(samples.length);
    const weight = Number((2n * BigInt(WEIGHT_UNIT) * BigInt(count) + k) / (2n * k));
    if (weight < 1 || weight > U32_MAX) throw new RangeError(`вес корзины ${String(index + 1)}: ${String(weight)} вне u32`);
    for (const sample of samples) wins.push({ seed: sample.seed, payX100: sample.payX100, weight });
  });
  let paid = 0n;
  let winWeight = 0n;
  for (const record of wins) {
    paid += BigInt(record.weight) * BigInt(record.payX100);
    winWeight += BigInt(record.weight);
  }
  // Σ весов книги: paid / (100 × total) = 96/100 → total = paid / 96; округление до ближайшего целого.
  const total = (2n * paid + RTP_NUMERATOR) / (2n * RTP_NUMERATOR);
  const lossWeight = total - winWeight;
  const lossRecords = BigInt(losses.length);
  if (lossWeight < lossRecords) throw new RangeError('пулу проигрышей не хватает веса: RTP прообраза выше 0.96 на всю долю проигрышей');
  const per = lossWeight / lossRecords;
  const extra = Number(lossWeight % lossRecords);
  if (per + 1n > BigInt(U32_MAX)) throw new RangeError(`вес записи проигрыша ${String(per)} вне u32`);
  const sortedLosses = [...losses].sort((a, b) => a.seed - b.seed);
  const lossesWeighted = sortedLosses.map((sample, index): BookRecord => ({ seed: sample.seed, payX100: 0, weight: Number(per) + (index < extra ? 1 : 0) }));
  const records = [...lossesWeighted, ...wins].sort((a, b) => a.payX100 - b.payX100 || a.seed - b.seed);
  return { records, paid, total };
}
