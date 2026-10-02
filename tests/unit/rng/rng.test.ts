import { describe, expect, it } from 'vitest';
import { SplitMix32, Xoshiro128ss, fmix32 } from '../../../src/core/rng/index.ts';
import { fmix32Big, splitmix32Big, xoshiro128ssBig } from './bigint-reference.ts';

// Литералы напечатаны tests/reference/vectors.cpp, собранным из официальных файлов:
//   https://prng.di.unimi.it/xoshiro128starstar.c  sha256 2e3e540e15e1b1edf6144509ba3a71bc4611e3676d52e03d567a0f230a141a67
//   https://raw.githubusercontent.com/aappleby/smhasher/master/src/MurmurHash3.cpp
//                                                  sha256 30f121ed155ebf336af398aabb7d8d157afdfafc8d981e7b48d2a1ceb4b63e4e
// Адреса и суммы остальных файлов — в заголовке vectors.cpp.

const FMIX32: [number, number][] = [
  [0x00000000, 0x00000000],
  [0x00000001, 0x514e28b7],
  [0x00000002, 0x30f4c306],
  [0x80000000, 0x6d3c65a0],
  [0x9e3779b9, 0x92ca2f0e],
  [0xdeadbeef, 0x0de5c6a9],
  [0xffffffff, 0x81f16f39],
  [0x075bcd15, 0xba60d89a],
];

const SPLITMIX32: [number, number[]][] = [
  [0x00000000, [0x92ca2f0e, 0x3cd6e3f3, 0x1b147dcc, 0x4c081dbf, 0x487981ab, 0xdb408c9d]],
  [0x00000001, [0x96a0f96b, 0x12bc8390, 0x971e9964, 0x79adc7e7, 0x591c8dd8, 0xcd6587c9]],
  [0x0000002a, [0x3805ea2c, 0xeb5cd984, 0x1327aacb, 0xc5ba443d, 0x1f6f60bf, 0xa10cc271]],
  [0x000007ea, [0xdce4c433, 0x38fe1e01, 0x1e35a029, 0x36aea6c2, 0x3b88be2a, 0x338dc4af]],
  [0x9e3779b9, [0x3cd6e3f3, 0x1b147dcc, 0x4c081dbf, 0x487981ab, 0xdb408c9d, 0x78bc1b8f]],
  [0xffffffff, [0x36deb503, 0xfc2fb9b6, 0x2994c1b5, 0x6a06e134, 0x10b80437, 0x596d3e7f]],
];

const XOSHIRO128SS: [number, number[]][] = [
  [0x00000000, [0xe308dc58, 0x4392d0e4, 0x03318f97, 0xac593a63, 0x08535f0a, 0x83532d1f, 0x063f9b44, 0x5e9c32a6]],
  [0x00000001, [0x9190299e, 0xc1017b27, 0xe3af522f, 0x7d71fb05, 0x787816c2, 0xfbbe0c00, 0x5a5c175a, 0x89063de1]],
  [0x0000002a, [0xa91e1cac, 0x207b36e9, 0x1c987ffa, 0xd09fde9e, 0x14404494, 0x06bee32a, 0x03e4c0b2, 0x424bc820]],
  [0x000007ea, [0x55a316fe, 0x2c3b6379, 0x67853078, 0x4e406dcf, 0xa19e77ea, 0xd66e66c6, 0x443dccfc, 0xbb47d0e7]],
  [0x9e3779b9, [0x4d0e705b, 0x4c8ec075, 0x7800bf96, 0xdcc1d59d, 0xdd2a4e9f, 0x2cbfbc45, 0xbf9de59b, 0x52270d4c]],
  [0xffffffff, [0x31d28326, 0x728481f8, 0x8c70d5d1, 0x7066baf4, 0x3a707f2c, 0x3ed16aa6, 0xdb308f61, 0x92e32daa]],
];

const hex = (n: number): string => `0x${n.toString(16).padStart(8, '0')}`;

function draws(next: () => number, count: number): number[] {
  return Array.from({ length: count }, next);
}

// Сиды для второго пути: подряд с нуля, степени двойки и края диапазона.
const BIGINT_SEEDS = [
  ...Array.from({ length: 300 }, (_, i) => i),
  ...Array.from({ length: 32 }, (_, i) => 2 ** i),
  0x7fffffff,
  0xfffffffe,
  0xffffffff,
];

describe('fmix32 против официального MurmurHash3', () => {
  it.each(FMIX32.map(([x, y]) => [hex(x), hex(y), x, y] as const))('fmix32(%s) = %s', (_x, _y, x, y) => {
    expect(fmix32(x)).toBe(y);
  });
});

describe('SplitMix32 против шага Вейля и официального fmix32', () => {
  it.each(SPLITMIX32.map(([seed, out]) => [hex(seed), seed, out] as const))('сид %s', (_name, seed, out) => {
    const mixer = new SplitMix32(seed);
    expect(draws(() => mixer.next(), out.length)).toEqual(out);
  });

  it('reset возвращает поток к началу сида', () => {
    const mixer = new SplitMix32(7);
    draws(() => mixer.next(), 5);
    mixer.reset(42);
    expect(draws(() => mixer.next(), 6)).toEqual(SPLITMIX32[2]?.[1]);
  });
});

describe('Xoshiro128ss против официального xoshiro128starstar.c', () => {
  it.each(XOSHIRO128SS.map(([seed, out]) => [hex(seed), seed, out] as const))('сид %s', (_name, seed, out) => {
    const rng = new Xoshiro128ss(seed);
    expect(draws(() => rng.nextU32(), out.length)).toEqual(out);
  });

  it('reseed после чужого потока даёт то же, что новый экземпляр', () => {
    const reused = new Xoshiro128ss(123);
    draws(() => reused.nextU32(), 1000);
    for (const seed of [0, 1, 2026, 0xffffffff]) {
      reused.reseed(seed);
      const fresh = new Xoshiro128ss(seed);
      expect(draws(() => reused.nextU32(), 32)).toEqual(draws(() => fresh.nextU32(), 32));
    }
  });
});

describe('второй путь: BigInt без imul и >>> 0', () => {
  it('fmix32 совпадает на сидах и их образах', () => {
    const inputs = BIGINT_SEEDS.flatMap((seed) => [seed, (seed ^ 0xdeadbeef) >>> 0]);
    expect(inputs.map((x) => fmix32(x))).toEqual(inputs.map((x) => Number(fmix32Big(BigInt(x)))));
  });

  it('SplitMix32 совпадает', () => {
    for (const seed of BIGINT_SEEDS) {
      const mixer = new SplitMix32(seed);
      expect(draws(() => mixer.next(), 8), hex(seed)).toEqual(splitmix32Big(BigInt(seed), 8).map(Number));
    }
  });

  it('Xoshiro128ss совпадает', () => {
    for (const seed of BIGINT_SEEDS) {
      const rng = new Xoshiro128ss(seed);
      expect(draws(() => rng.nextU32(), 64), hex(seed)).toEqual(xoshiro128ssBig(BigInt(seed), 64).map(Number));
    }
  });
});

describe('сид — только целое от 0 до 2^32 − 1', () => {
  const BAD = [-1, 2 ** 32, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

  it.each(BAD)('SplitMix32(%s) бросает', (seed) => {
    expect(() => new SplitMix32(seed)).toThrow(RangeError);
    expect(() => new SplitMix32(seed)).toThrow(`seed: ожидается целое от 0 до 2^32 − 1, получено ${String(seed)}`);
  });

  it.each(BAD)('Xoshiro128ss и reseed с сидом %s бросают', (seed) => {
    expect(() => new Xoshiro128ss(seed)).toThrow(RangeError);
    expect(() => {
      new Xoshiro128ss(0).reseed(seed);
    }).toThrow(RangeError);
  });
});
