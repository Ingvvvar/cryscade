import { fmix32 } from '../../src/core/rng/index.ts';
import { BUCKETS, bucketOf } from '../math/buckets.ts';

// Прообраз книги (§5): сколько раундов в каждой корзине и какие из них сохранить. В корзине сохраняются K раундов с
// наименьшим хешем сида, редкие — все: выбор — функция набора сидов, а не порядка, в котором их считали потоки, поэтому
// книга побайтно одна при любом числе потоков. Хеш сида — перемешивание, не связанное с потоком символов движка
// (там — Вейль и fmix32 от сида раунда): иначе выборка могла бы зацепить исход.

/** Сохраняется раундов на корзину; реже — все. */
export const BOOK_PER_BUCKET = 5000;

export interface BookSample {
  readonly hash: number;
  readonly seed: number;
  readonly payX100: number;
}

/** Простые данные: переживают postMessage. */
export interface CollectorPlain {
  /** Раундов по корзинам — природная частота. */
  readonly counts: readonly number[];
  /** Выборки корзин по возрастанию хеша, не длиннее BOOK_PER_BUCKET. */
  readonly samples: readonly (readonly BookSample[])[];
}

export function seedHash(seed: number): number {
  return fmix32(Math.imul(seed ^ 0x5bd1e995, 0x27d4eb2d) >>> 0);
}

const byHash = (a: BookSample, b: BookSample): number => a.hash - b.hash;

export class BookCollector {
  readonly #capX100: number;
  readonly #perBucket: number;
  readonly #counts: number[] = BUCKETS.map(() => 0);
  readonly #samples: BookSample[][] = BUCKETS.map(() => []);

  constructor(capX100: number, perBucket = BOOK_PER_BUCKET) {
    this.#capX100 = capX100;
    this.#perBucket = perBucket;
  }

  add(seed: number, payX100: number): void {
    const bucket = bucketOf(payX100, this.#capX100);
    this.#counts[bucket] = (this.#counts[bucket] ?? 0) + 1;
    const list = this.#samples[bucket] ?? [];
    list.push({ hash: seedHash(seed), seed, payX100 });
    if (list.length >= 2 * this.#perBucket) this.#trim(bucket);
  }

  merge(plain: CollectorPlain): void {
    plain.counts.forEach((count, bucket) => {
      this.#counts[bucket] = (this.#counts[bucket] ?? 0) + count;
      const list = this.#samples[bucket] ?? [];
      list.push(...(plain.samples[bucket] ?? []));
      this.#trim(bucket);
    });
  }

  toPlain(): CollectorPlain {
    this.#samples.forEach((_, bucket) => {
      this.#trim(bucket);
    });
    return { counts: [...this.#counts], samples: this.#samples.map((list) => [...list]) };
  }

  #trim(bucket: number): void {
    const list = this.#samples[bucket];
    if (list === undefined) return;
    list.sort(byHash);
    if (list.length > this.#perBucket) list.length = this.#perBucket;
  }
}
