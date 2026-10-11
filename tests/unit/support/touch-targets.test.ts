import { describe, expect, it } from 'vitest';
import type { Image } from '../../support/png.ts';
import { NOTHING, OFFSCREEN, ringReport, signedDistance, verdict, type HitMap, type Shape } from '../../support/touch-targets.ts';

// Арифметика проверки касаний (прогон №6) на литералах: расстояния — посчитаны вручную, счёт пикселей — периметр
// квадратного кольца (n × n пикселей — 4n − 4).

const square = (x: number, y: number, size: number, radius: number): Shape => ({ x, y, width: size, height: size, radii: [radius, radius, radius, radius] });

describe('расстояние до формы', () => {
  it('прямоугольник без скругления — по Чебышёву: прямой угол outline', () => {
    const shape = square(0, 0, 10, 0);
    expect(signedDistance(shape, 5, 5)).toBe(-5);
    expect(signedDistance(shape, 15, 5)).toBe(5);
    expect(signedDistance(shape, 12, 12)).toBe(2);
    expect(signedDistance(shape, -3, 5)).toBe(3);
  });

  it('круг: от центра −r, от края наружу — евклидово, угол описанного квадрата — r(√2 − 1)', () => {
    const circle = square(0, 0, 20, 10);
    expect(signedDistance(circle, 10, 10)).toBe(-10);
    expect(signedDistance(circle, 10, -5)).toBe(5);
    expect(signedDistance(circle, 0, 0)).toBeCloseTo(4.142135, 5);
  });

  it('у каждого угла свой радиус; радиус больше половины стороны — до половины', () => {
    const mixed: Shape = { x: 0, y: 0, width: 20, height: 20, radii: [0, 10, 0, 0] };
    expect(signedDistance(mixed, 25, -5)).toBeCloseTo(11.213203, 5);
    expect(signedDistance(mixed, -5, -5)).toBe(5);
    expect(signedDistance(square(0, 0, 20, 50), 0, 0)).toBeCloseTo(4.142135, 5);
    const pill: Shape = { x: 0, y: 0, width: 40, height: 20, radii: [5, 5, 5, 5] };
    expect(signedDistance(pill, -2, 10)).toBe(2);
  });
});

/** Карта 4 × 4 вокруг центра (4, 4) на квадрат 2 × 2: середины пикселей 2.5 … 5.5. */
function map(rows: readonly (readonly number[])[]): HitMap {
  return { cx: 4, cy: 4, span: 4, owners: rows.flat() };
}

describe('квадрат области нажатия', () => {
  it('square: квадрат из точек элемента с центром внутри, и у края тоже', () => {
    const full = map([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    expect(verdict(full, 0, [], 2).verdict).toBe('square');
    const corner = map([
      [0, 0, NOTHING, NOTHING],
      [0, 0, NOTHING, NOTHING],
      [NOTHING, NOTHING, NOTHING, NOTHING],
      [NOTHING, NOTHING, NOTHING, NOTHING],
    ]);
    expect(verdict(corner, 0, [], 2).verdict).toBe('square');
  });

  it('small: свободная точка квадрата вокруг центра — не у элемента; у соседа без видимой формы там — тоже small', () => {
    const hole = map([
      [NOTHING, NOTHING, NOTHING, NOTHING],
      [NOTHING, 0, 0, NOTHING],
      [NOTHING, 0, NOTHING, NOTHING],
      [NOTHING, NOTHING, NOTHING, NOTHING],
    ]);
    expect(verdict(hole, 0, [], 2)).toStrictEqual({ verdict: 'small', free: { x: 4.5, y: 4.5, owner: NOTHING } });
    const stolen = map([
      [NOTHING, NOTHING, NOTHING, NOTHING],
      [NOTHING, 0, 0, NOTHING],
      [NOTHING, 0, 1, NOTHING],
      [NOTHING, NOTHING, NOTHING, NOTHING],
    ]);
    expect(verdict(stolen, 0, [square(10, 10, 4, 0)], 2)).toStrictEqual({ verdict: 'small', free: { x: 4.5, y: 4.5, owner: 1 } });
  });

  it('blocked: недостающие точки — под видимой формой соседа (с краем 1.5 px: попадание шире рамки) или вне окна', () => {
    const neighbour = map([
      [NOTHING, NOTHING, NOTHING, NOTHING],
      [NOTHING, 0, 0, NOTHING],
      [NOTHING, 0, 1, NOTHING],
      [NOTHING, NOTHING, NOTHING, NOTHING],
    ]);
    // Точка (4.5, 4.5): внутри соседа 4.2…5.2; в 1.4 px от соседа 5.9…6.9 — его край; в 1.6 px от 6.1…7.1 — уже нет.
    expect(verdict(neighbour, 0, [square(4.2, 4.2, 1, 0)], 2)).toStrictEqual({ verdict: 'blocked', free: null });
    expect(verdict(neighbour, 0, [square(5.9, 5.9, 1, 0)], 2).verdict).toBe('blocked');
    expect(verdict(neighbour, 0, [square(6.1, 6.1, 1, 0)], 2).verdict).toBe('small');
    const edge = map([
      [OFFSCREEN, OFFSCREEN, OFFSCREEN, OFFSCREEN],
      [OFFSCREEN, OFFSCREEN, OFFSCREEN, OFFSCREEN],
      [NOTHING, 0, 0, NOTHING],
      [NOTHING, NOTHING, NOTHING, NOTHING],
    ]);
    expect(verdict(edge, 0, [], 2).verdict).toBe('blocked');
  });

  it('карта не той величины — ошибка, а не молчаливый ответ', () => {
    expect(() => verdict(map([[0, 0, 0, 0]]), 0, [], 2)).toThrow('карта 4² на квадрат 2');
  });
});

/** Снимок 30 × 30: белые пиксели — там, где paint возвращает true; середины пикселей — (ix + 0.5, iy + 0.5). */
function image(paint: (x: number, y: number) => boolean): Image {
  const rgba = new Uint8Array(30 * 30 * 4);
  for (let iy = 0; iy < 30; iy++) {
    for (let ix = 0; ix < 30; ix++) {
      const value = paint(ix + 0.5, iy + 0.5) ? 255 : 0;
      rgba.set([value, value, value, 255], (iy * 30 + ix) * 4);
    }
  }
  return { width: 30, height: 30, rgba };
}

describe('рамка по пикселям', () => {
  // Квадрат 10 × 10 в (10, 10), рамка: отступ 2, толщина 4; середина полосы при dpr 1 — расстояния 3.5 и 4.5:
  // кольца 18 × 18 и 20 × 20 пикселей, 68 + 76 = 144.
  const box = square(10, 10, 10, 0);
  const ring = { offset: 2, width: 4 };
  const clip = { x: 0, y: 0, width: 30, height: 30 };
  const off = image(() => false);
  const drawn = (x: number, y: number): boolean => {
    const distance = signedDistance(box, x, y);
    return distance >= 2 && distance <= 6;
  };

  it('рамка по форме: лишних нет, середина полосы покрыта вся', () => {
    expect(ringReport(box, ring, clip, 1, image(drawn), off, clip)).toStrictEqual({ stray: 0, band: 144, covered: 144, strayAt: [] });
  });

  it('отличие дальше полосы — лишнее, внутри формы — не считается; видимая часть ограничивает полосу', () => {
    const extra = image((x, y) => drawn(x, y) || (x === 0.5 && y === 15.5) || (x === 15.5 && y === 15.5));
    expect(ringReport(box, ring, clip, 1, extra, off, clip)).toStrictEqual({ stray: 1, band: 144, covered: 144, strayAt: ['0.5,15.5 d=9.5'] });
    // Видна левая половина (x < 15): кольцо 18 — столбец 18 и по 8 сверху и снизу; кольцо 20 — 20 и по 9.
    expect(ringReport(box, ring, clip, 1, image(drawn), off, { x: 0, y: 0, width: 15, height: 30 })).toStrictEqual({ stray: 0, band: 72, covered: 72, strayAt: [] });
  });

  it('рамка, сдвинутая на пиксель устройства, покрывает соседнюю строку полосы, на два — нет', () => {
    // Нарисовано только кольцо 2.5: кольцо полосы 3.5 рядом с ним (68), кольцо 4.5 — через одно (0).
    const inward = image((x, y) => signedDistance(box, x, y) === 2.5);
    expect(ringReport(box, ring, clip, 1, inward, off, clip)).toStrictEqual({ stray: 0, band: 144, covered: 68, strayAt: [] });
  });

  it('рамки нет — полоса не покрыта; квадратная рамка вокруг круга — лишние точки в углах', () => {
    expect(ringReport(box, ring, clip, 1, off, off, clip).covered).toBe(0);
    const circle = square(10, 10, 10, 5);
    const report = ringReport(circle, ring, clip, 1, image(drawn), off, clip);
    expect(report.stray).toBeGreaterThan(0);
    expect(report.strayAt[0]).toMatch(/d=\d/);
  });
});
