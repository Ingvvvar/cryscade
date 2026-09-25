// Второй путь сверки ГСЧ: те же алгоритмы на BigInt с явной маской 2^32 — без Math.imul и без >>> 0.
// Первый путь — литералы из официальных исходников (tests/reference/vectors.cpp).

const MASK = 0xffffffffn;

export function fmix32Big(x: bigint): bigint {
  let h = x & MASK;
  h ^= h >> 16n;
  h = (h * 0x85ebca6bn) & MASK;
  h ^= h >> 13n;
  h = (h * 0xc2b2ae35n) & MASK;
  h ^= h >> 16n;
  return h;
}

export function splitmix32Big(seed: bigint, count: number): bigint[] {
  const out: bigint[] = [];
  let state = seed & MASK;
  for (let i = 0; i < count; i++) {
    state = (state + 0x9e3779b9n) & MASK;
    out.push(fmix32Big(state));
  }
  return out;
}

const rotl = (x: bigint, k: bigint): bigint => ((x << k) | (x >> (32n - k))) & MASK;

export function xoshiro128ssBig(seed: bigint, count: number): bigint[] {
  let [s0, s1, s2, s3] = splitmix32Big(seed, 4) as [bigint, bigint, bigint, bigint];
  const out: bigint[] = [];
  for (let i = 0; i < count; i++) {
    out.push((rotl((s1 * 5n) & MASK, 7n) * 9n) & MASK);
    const t = (s1 << 9n) & MASK;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11n);
  }
  return out;
}
