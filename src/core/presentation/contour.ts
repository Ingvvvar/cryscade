// Контур кластера (§8.4): marching squares по маске клеток — многоугольник, с дырами, если они есть, а не рамки вокруг
// клеток. Маска выбирается SUBDIVISION раз на сторону клетки: контур идёт по границам клеток и срезает углы на
// 1/(2·SUBDIVISION) клетки, не заходя на символы. Седло (два символа кластера касаются углом) разрешается по
// 4-связности: кластер связан по сторонам, углом касающиеся клетки контур не соединяет. Строится при сборке
// расписания, не на кадре. Координаты — в клетках: сетка — квадрат [0, 7] × [0, 7], y вниз.

import { CELL_COUNT, GRID_SIDE } from '../model/grid.ts';

export const SUBDIVISION = 4;

/** Кольцо: x0, y0, x1, y1, … в клетках; замкнуто — после последней точки идёт первая. */
export type ContourRing = Float64Array;

const SAMPLES = GRID_SIDE * SUBDIVISION;

/** Маска подвыборки с полем в одну точку по краю: индексы от −1 до SAMPLES. */
function sampled(mask: Uint8Array, i: number, j: number): number {
  if (i < 0 || j < 0 || i >= SAMPLES || j >= SAMPLES) return 0;
  const cell = Math.floor(j / SUBDIVISION) * GRID_SIDE + Math.floor(i / SUBDIVISION);
  return mask[cell] ?? 0;
}

/** Точка — в полуединицах подвыборки: целые, ключ карты без плавающей точки. */
const key = (x: number, y: number): number => x * 1024 + y;

/**
 * Отрезки квадрата по его случаю: углы tl, tr, br, bl (y вниз), середины сторон T, R, B, L. Седла 5 и 10 — углы
 * кластера разделены: каждый срезается своим отрезком.
 */
const CASES: readonly (readonly (readonly [Side, Side])[])[] = [
  [],
  [['L', 'B']],
  [['B', 'R']],
  [['L', 'R']],
  [['T', 'R']],
  [
    ['L', 'B'],
    ['T', 'R'],
  ],
  [['T', 'B']],
  [['T', 'L']],
  [['T', 'L']],
  [['T', 'B']],
  [
    ['T', 'L'],
    ['R', 'B'],
  ],
  [['T', 'R']],
  [['L', 'R']],
  [['R', 'B']],
  [['L', 'B']],
  [],
];

type Side = 'T' | 'R' | 'B' | 'L';

/** Середина стороны квадрата с левым верхним углом (i, j) — в полуединицах подвыборки. */
function midpoint(i: number, j: number, side: Side): readonly [number, number] {
  switch (side) {
    case 'T':
      return [2 * i + 2, 2 * j + 1];
    case 'R':
      return [2 * i + 3, 2 * j + 2];
    case 'B':
      return [2 * i + 2, 2 * j + 3];
    case 'L':
      return [2 * i + 1, 2 * j + 2];
  }
}

/** Кольца контура кластера по его клеткам; пустой кластер — колец нет. */
export function clusterContour(cells: readonly number[]): ContourRing[] {
  const mask = new Uint8Array(CELL_COUNT);
  for (const cell of cells) {
    if (!Number.isSafeInteger(cell) || cell < 0 || cell >= CELL_COUNT) throw new RangeError(`контур: клетка ${String(cell)} вне сетки`);
    mask[cell] = 1;
  }
  // Отрезки: смежность точек. У каждой точки контура ровно два соседа — кольца не ветвятся.
  const links = new Map<number, number[]>();
  const coords = new Map<number, readonly [number, number]>();
  const link = (a: readonly [number, number], b: readonly [number, number]): void => {
    const ka = key(a[0], a[1]);
    const kb = key(b[0], b[1]);
    coords.set(ka, a);
    coords.set(kb, b);
    links.set(ka, [...(links.get(ka) ?? []), kb]);
    links.set(kb, [...(links.get(kb) ?? []), ka]);
  };
  for (let j = -1; j < SAMPLES; j++) {
    for (let i = -1; i < SAMPLES; i++) {
      const index = sampled(mask, i, j) * 8 + sampled(mask, i + 1, j) * 4 + sampled(mask, i + 1, j + 1) * 2 + sampled(mask, i, j + 1);
      for (const [from, to] of CASES[index] ?? []) link(midpoint(i, j, from), midpoint(i, j, to));
    }
  }
  const rings: ContourRing[] = [];
  const visited = new Set<number>();
  for (const start of links.keys()) {
    if (visited.has(start)) continue;
    const loop: number[] = [];
    let current = start;
    while (!visited.has(current)) {
      visited.add(current);
      loop.push(current);
      // Предыдущая точка уже посещена: шаг назад отсекает то же условие.
      const next = (links.get(current) ?? []).find((candidate) => !visited.has(candidate));
      if (next === undefined) break;
      current = next;
    }
    rings.push(simplified(loop.map((k) => coords.get(k) ?? [0, 0])));
  }
  return rings;
}

/** Точки на прямой между соседями убираются; координаты — из полуединиц подвыборки в клетки. */
function simplified(points: readonly (readonly [number, number])[]): ContourRing {
  const kept: (readonly [number, number])[] = [];
  for (let index = 0; index < points.length; index++) {
    const before = points[(index + points.length - 1) % points.length] ?? [0, 0];
    const at = points[index] ?? [0, 0];
    const after = points[(index + 1) % points.length] ?? [0, 0];
    const cross = (at[0] - before[0]) * (after[1] - at[1]) - (at[1] - before[1]) * (after[0] - at[0]);
    if (cross !== 0) kept.push(at);
  }
  const unit = 2 * SUBDIVISION;
  const ring = new Float64Array(2 * kept.length);
  kept.forEach(([x, y], index) => {
    ring[2 * index] = x / unit;
    ring[2 * index + 1] = y / unit;
  });
  return ring;
}

/** Точка внутри контура — правило чётности по всем кольцам: дыра вычитается. */
export function contourContains(rings: readonly ContourRing[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    const count = ring.length / 2;
    for (let a = 0, b = count - 1; a < count; b = a++) {
      const ax = ring[2 * a] ?? 0;
      const ay = ring[2 * a + 1] ?? 0;
      const bx = ring[2 * b] ?? 0;
      const by = ring[2 * b + 1] ?? 0;
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
  }
  return inside;
}
