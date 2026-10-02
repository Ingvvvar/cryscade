import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { clusterContour, contourContains, SUBDIVISION } from '../../../src/core/presentation/contour.ts';

// Контур кластера (§8.4, §8.5): замкнут и содержит центры ровно клеток кластера. Литералы — посчитаны руками по
// сетке подвыборки: контур идёт по границе клеток, угол срезан на 1/(2·4) = 0.125 клетки.

const points = (rings: readonly Float64Array[]): number[][] => rings.map((r) => [...r]);
/** Вершины кольца — отсортированным набором «x,y»: порядок обхода и начальная точка не важны. */
const vertexSet = (r: Float64Array | undefined): string[] =>
  Array.from({ length: (r?.length ?? 0) / 2 }, (_, i) => `${String(r?.[2 * i])},${String(r?.[2 * i + 1])}`).sort();

describe('clusterContour — литералы', () => {
  it('подвыборка — 4 на сторону клетки', () => {
    expect(SUBDIVISION).toBe(4);
  });

  it('одна клетка (0, 0): восьмиугольник по её краю, углы срезаны на 0.125', () => {
    const rings = clusterContour([0]);
    expect(rings).toHaveLength(1);
    expect(vertexSet(rings[0])).toStrictEqual(
      ['0.125,0', '0.875,0', '1,0.125', '1,0.875', '0.875,1', '0.125,1', '0,0.875', '0,0.125'].sort(),
    );
  });

  it('блок 2 × 2 в углу — одно кольцо на восемь вершин по внешнему краю блока', () => {
    const rings = clusterContour([0, 1, 7, 8]);
    expect(rings).toHaveLength(1);
    expect(vertexSet(rings[0])).toStrictEqual(
      ['0.125,0', '1.875,0', '2,0.125', '2,1.875', '1.875,2', '0.125,2', '0,1.875', '0,0.125'].sort(),
    );
  });

  it('уголок из трёх клеток: внутренний угол тоже срезан — шесть сторон и два среза, десять вершин', () => {
    const rings = clusterContour([0, 1, 7]);
    expect(rings).toHaveLength(1);
    expect(vertexSet(rings[0])).toContain('1.125,1');
    expect(vertexSet(rings[0])).toContain('1,1.125');
    expect(rings[0]?.length).toBe(2 * 12);
  });

  it('кольцо из восьми клеток вокруг пустой — два кольца: внешнее и дыра; центр дыры снаружи', () => {
    const rings = clusterContour([8, 9, 10, 15, 17, 22, 23, 24]);
    expect(rings).toHaveLength(2);
    expect(contourContains(rings, 2.5, 2.5)).toBe(false);
    expect(contourContains(rings, 1.5, 1.5)).toBe(true);
  });

  it('клетки кластера касаются углом (седло) — углом контур их не соединяет', () => {
    // Кластер по сторонам: (0,0) (1,0) (1,1)… но проверяем именно диагональ: (0,0) и (1,1) в кластере, (1,0) и (0,1) — нет.
    const rings = clusterContour([0, 8]);
    expect(rings).toHaveLength(2);
    expect(contourContains(rings, 1, 1)).toBe(false);
  });

  it('седло другой диагонали: (0,1) и (1,0) — тоже два кольца', () => {
    const rings = clusterContour([1, 7]);
    expect(rings).toHaveLength(2);
    expect(contourContains(rings, 1, 1)).toBe(false);
  });

  it('вся сетка — одно кольцо по краю сетки', () => {
    const rings = clusterContour(Array.from({ length: 49 }, (_, cell) => cell));
    expect(points(rings).map((r) => r.length)).toStrictEqual([8 * 2]);
  });

  it('клетка вне сетки — ошибка; пустой кластер — колец нет', () => {
    expect(() => clusterContour([49])).toThrow(RangeError);
    expect(clusterContour([])).toStrictEqual([]);
  });
});

/** Случайный 4-связный набор клеток: рост от случайной клетки по сторонам. */
const CLUSTER = fc
  .record({ seed: fc.nat(48), steps: fc.array(fc.nat(3), { minLength: 0, maxLength: 30 }), picks: fc.array(fc.nat(1000), { minLength: 30, maxLength: 30 }) })
  .map(({ seed, steps, picks }) => {
    const cells = new Set([seed]);
    steps.forEach((direction, index) => {
      const list = [...cells];
      const from = list[(picks[index] ?? 0) % list.length] ?? seed;
      const row = Math.floor(from / 7);
      const col = from % 7;
      const dr = [-1, 1, 0, 0][direction] ?? 0;
      const dc = [0, 0, -1, 1][direction] ?? 0;
      const r = row + dr;
      const c = col + dc;
      if (r >= 0 && r < 7 && c >= 0 && c < 7) cells.add(r * 7 + c);
    });
    return [...cells].sort((a, b) => a - b);
  });

describe('clusterContour — границы', () => {
  it.each([-1, 49, 1.5])('клетка %s — RangeError с её номером', (cell) => {
    expect(() => clusterContour([0, cell])).toThrow(RangeError);
    expect(() => clusterContour([0, cell])).toThrow(`контур: клетка ${String(cell)} вне сетки`);
  });

  it('срезанные углы клетки — снаружи, на четверть клетки внутрь — внутри', () => {
    // Клетка (2, 3): срез угла — 1/8 клетки по каждой оси, точка в 0.05 от угла лежит за срезом.
    const rings = clusterContour([3 * 7 + 2]);
    const corners = [
      [2.05, 3.05],
      [2.95, 3.05],
      [2.95, 3.95],
      [2.05, 3.95],
    ];
    // Середины верхнего и нижнего края — на высоте срезов: луч вправо пересекает срез, и точка внутри.
    const inner = [
      [2.25, 3.25],
      [2.75, 3.25],
      [2.75, 3.75],
      [2.25, 3.75],
      [2.5, 3.05],
      [2.5, 3.95],
    ];
    expect(corners.map(([x = 0, y = 0]) => contourContains(rings, x, y))).toStrictEqual([false, false, false, false]);
    expect(inner.map(([x = 0, y = 0]) => contourContains(rings, x, y))).toStrictEqual([true, true, true, true, true, true]);
  });
});

describe('clusterContour — property', () => {
  it('кольца замкнуты (вершин ≥ 4, у каждого ребра — ось или срез 45°), центры внутри — ровно клетки кластера', () => {
    fc.assert(
      fc.property(CLUSTER, (cells) => {
        const rings = clusterContour(cells);
        for (const r of rings) {
          const count = r.length / 2;
          expect(count).toBeGreaterThanOrEqual(4);
          for (let a = 0; a < count; a++) {
            const b = (a + 1) % count;
            const dx = Math.abs((r[2 * b] ?? 0) - (r[2 * a] ?? 0));
            const dy = Math.abs((r[2 * b + 1] ?? 0) - (r[2 * a + 1] ?? 0));
            expect(dx === 0 || dy === 0 || dx === dy).toBe(true);
          }
        }
        const inside = Array.from({ length: 49 }, (_, cell) => contourContains(rings, (cell % 7) + 0.5, Math.floor(cell / 7) + 0.5));
        expect(inside).toStrictEqual(Array.from({ length: 49 }, (_, cell) => cells.includes(cell)));
      }),
      { numRuns: 500 },
    );
  });
});
