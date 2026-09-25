// splitmix32 по §4.7: шаг Вейля 0x9E3779B9 и финализатор fmix32 из MurmurHash3.
// Эталон — официальный MurmurHash3.cpp из smhasher (tests/reference/vectors.cpp).

const WEYL_STEP = 0x9e3779b9;

/** Финализатор fmix32 из MurmurHash3. Биекция на u32: ноль даёт только на нуле. */
export function fmix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Бросает, если value — не целое от 0 до 2^32 − 1. */
function assertU32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name}: ожидается целое от 0 до 2^32 − 1, получено ${String(value)}`);
  }
}

export class SplitMix32 {
  #state = 0;

  constructor(seed: number) {
    this.reset(seed);
  }

  reset(seed: number): void {
    assertU32(seed, 'seed');
    this.#state = seed;
  }

  next(): number {
    this.#state = (this.#state + WEYL_STEP) >>> 0;
    return fmix32(this.#state);
  }
}
