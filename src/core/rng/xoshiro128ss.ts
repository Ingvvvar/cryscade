// xoshiro128** 1.1 (Blackman, Vigna, 2018). Эталон — официальный xoshiro128starstar.c
// с prng.di.unimi.it (tests/reference/vectors.cpp).

import type { Random } from './random.ts';
import { SplitMix32 } from './splitmix32.ts';

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

export class Xoshiro128ss implements Random {
  readonly #seeder: SplitMix32;
  #s0 = 0;
  #s1 = 0;
  #s2 = 0;
  #s3 = 0;

  constructor(seed: number) {
    this.#seeder = new SplitMix32(seed);
    this.reseed(seed);
  }

  /**
   * Состояние — первые четыре выхода splitmix32 от сида (§4.7). Меняется на месте, без аллокаций:
   * один экземпляр служит всем раундам симуляции. Нулевого состояния не бывает — fmix32 биекция.
   */
  reseed(seed: number): void {
    this.#seeder.reset(seed);
    this.#s0 = this.#seeder.next();
    this.#s1 = this.#seeder.next();
    this.#s2 = this.#seeder.next();
    this.#s3 = this.#seeder.next();
  }

  nextU32(): number {
    const s0 = this.#s0;
    const s1 = this.#s1;
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    const s2 = this.#s2 ^ s0;
    const s3 = this.#s3 ^ s1;
    this.#s1 = s1 ^ s2;
    this.#s0 = s0 ^ s3;
    this.#s2 = s2 ^ t;
    this.#s3 = rotl(s3, 11);
    return result;
  }
}
