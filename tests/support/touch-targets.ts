// Область нажатия и рамка фокуса на телефоне (§11, прогон №6) — арифметика без браузера. Страница отдаёт только карты
// попаданий и снимки; что считать «квадратом 44 × 44» и «рамкой по форме кнопки», решают эти функции — их юнит-тест на
// литералах (tests/unit/support/touch-targets.test.ts).

import type { Image } from './png.ts';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Видимая форма элемента управления: рамка в CSS-пикселях окна и радиусы углов — верхний левый, верхний правый,
 *  нижний правый, нижний левый. */
export interface Shape extends Rect {
  readonly radii: readonly [number, number, number, number];
}

/**
 * Знаковое расстояние от точки до формы: меньше нуля — внутри. Скруглённый угол — дуга (outline браузера со скруглением
 * идёт на том же расстоянии), угол без скругления — прямой: такой угол у outline остаётся прямым.
 */
export function signedDistance(shape: Shape, px: number, py: number): number {
  const halfWidth = shape.width / 2;
  const halfHeight = shape.height / 2;
  const qx = px - (shape.x + halfWidth);
  const qy = py - (shape.y + halfHeight);
  const [topLeft, topRight, bottomRight, bottomLeft] = shape.radii;
  const radius = Math.min(qy < 0 ? (qx < 0 ? topLeft : topRight) : qx < 0 ? bottomLeft : bottomRight, halfWidth, halfHeight);
  const ax = Math.abs(qx) - (halfWidth - radius);
  const ay = Math.abs(qy) - (halfHeight - radius);
  if (radius <= 0) return Math.max(ax, ay);
  return Math.min(Math.max(ax, ay), 0) + Math.hypot(Math.max(ax, 0), Math.max(ay, 0)) - radius;
}

/** Вне окна: точку не нажать. */
export const OFFSCREEN = -2;
/** В точке нет элемента управления. */
export const NOTHING = -1;

/**
 * Карта попаданий вокруг центра элемента: span × span точек с шагом 1 px — середины пикселей от (cx − span/2) и
 * (cy − span/2). Ячейка — номер элемента управления, который получает точку (elementFromPoint), NOTHING или OFFSCREEN.
 */
export interface HitMap {
  readonly cx: number;
  readonly cy: number;
  readonly span: number;
  readonly owners: readonly number[];
}

/**
 * square — есть квадрат side × side, весь из точек элемента, и центр элемента в нём (у края — тоже); blocked — такого
 * квадрата нет, но в квадрате вокруг центра каждая точка — элемента, кроме тех, что под видимой формой соседа или вне
 * окна: невидимой областью больше не набрать; small — в квадрате вокруг центра есть свободная точка не у элемента.
 */
export type Verdict = 'square' | 'blocked' | 'small';

/** Вердикт и для small — первая свободная точка не у элемента: где и чья (номер, NOTHING или OFFSCREEN). */
export interface Judged {
  readonly verdict: Verdict;
  readonly free: { readonly x: number; readonly y: number; readonly owner: number } | null;
}

/**
 * Край видимой формы соседа: попадание браузера шире геометрии рамки — точка в пределах EDGE от формы соседа считается
 * его. Замер прогона №6 (Chromium, Galaxy S5): верх «Авто» — 594, а (200, 593.4) уже «Авто»; (188.5, 593.5) в 1.19 px
 * от дуги его угла — тоже «Авто».
 */
const EDGE = 1.5;

export function verdict(map: HitMap, me: number, neighbours: readonly Shape[], side: number): Judged {
  const { span, owners } = map;
  if (span !== 2 * side || owners.length !== span * span) throw new Error(`карта ${String(span)}² на квадрат ${String(side)}`);
  const stride = span + 1;
  const sums = new Int32Array(stride * stride);
  for (let y = 0; y < span; y++) {
    for (let x = 0; x < span; x++) {
      const own = owners[y * span + x] === me ? 1 : 0;
      sums[(y + 1) * stride + x + 1] = own + (sums[y * stride + x + 1] ?? 0) + (sums[(y + 1) * stride + x] ?? 0) - (sums[y * stride + x] ?? 0);
    }
  }
  const area = (left: number, top: number): number =>
    (sums[(top + side) * stride + left + side] ?? 0) - (sums[top * stride + left + side] ?? 0) - (sums[(top + side) * stride + left] ?? 0) + (sums[top * stride + left] ?? 0);
  for (let top = 0; top <= side; top++) {
    for (let left = 0; left <= side; left++) if (area(left, top) === side * side) return { verdict: 'square', free: null };
  }
  const start = side / 2;
  for (let y = start; y < start + side; y++) {
    for (let x = start; x < start + side; x++) {
      const owner = owners[y * span + x] ?? NOTHING;
      if (owner === me || owner === OFFSCREEN) continue;
      const px = map.cx - span / 2 + x + 0.5;
      const py = map.cy - span / 2 + y + 0.5;
      if (neighbours.some((shape) => signedDistance(shape, px, py) <= EDGE)) continue;
      return { verdict: 'small', free: { x: px, y: py, owner } };
    }
  }
  return { verdict: 'blocked', free: null };
}

/** Рамка фокуса: отступ от рамки элемента и толщина, CSS-пиксели. */
export interface Ring {
  readonly offset: number;
  readonly width: number;
}

/**
 * Рамка по пикселям: снимки области clip с рамкой (on) и без неё (off), dpr пикселей устройства на CSS-пиксель.
 * stray — отличия снаружи формы вне полосы [offset, offset + width] с допуском на сглаживание и привязку к пикселям
 * устройства (рамка не той формы: квадрат вокруг круга); band — пиксели середины полосы в видимой части окна, covered —
 * из них отличающиеся (рамка есть со всех сторон). Отличия внутри формы не считаются: рамка рисуется снаружи.
 */
export interface RingReport {
  readonly stray: number;
  readonly band: number;
  readonly covered: number;
  /** Первые лишние точки, CSS-пиксели окна: где искать. */
  readonly strayAt: readonly string[];
}

/** Пиксель отличается: по одному из каналов больше этого. */
const DIFFERENT = 40;

export function ringReport(shape: Shape, ring: Ring, clip: Rect, dpr: number, on: Image, off: Image, visible: Rect): RingReport {
  if (on.width !== off.width || on.height !== off.height) throw new Error('снимки разного размера');
  const { width, height } = on;
  const tolerance = 0.75 + 2 / dpr;
  const inner = ring.offset + 1 / dpr;
  const outer = ring.offset + ring.width - 1 / dpr;
  const changed = new Uint8Array(width * height);
  for (let at = 0; at < width * height; at++) {
    const base = at * 4;
    if ([0, 1, 2].some((channel) => Math.abs((on.rgba[base + channel] ?? 0) - (off.rgba[base + channel] ?? 0)) > DIFFERENT)) changed[at] = 1;
  }
  // Рамку браузер привязывает к пикселям устройства: край полосы сдвигается на пиксель — покрытие считается с соседями.
  const near = (ix: number, iy: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = ix + dx;
        const y = iy + dy;
        if (x >= 0 && y >= 0 && x < width && y < height && changed[y * width + x] === 1) return true;
      }
    }
    return false;
  };
  let stray = 0;
  let band = 0;
  let covered = 0;
  const strayAt: string[] = [];
  for (let iy = 0; iy < height; iy++) {
    for (let ix = 0; ix < width; ix++) {
      const x = clip.x + (ix + 0.5) / dpr;
      const y = clip.y + (iy + 0.5) / dpr;
      const distance = signedDistance(shape, x, y);
      if (changed[iy * width + ix] === 1 && distance >= 0.5 && (distance < ring.offset - tolerance || distance > ring.offset + ring.width + tolerance)) {
        stray++;
        if (strayAt.length < 5) strayAt.push(`${x.toFixed(1)},${y.toFixed(1)} d=${distance.toFixed(1)}`);
      }
      const seen = x >= visible.x && y >= visible.y && x < visible.x + visible.width && y < visible.y + visible.height;
      if (seen && distance >= inner && distance <= outer) {
        band++;
        if (near(ix, iy)) covered++;
      }
    }
  }
  return { stray, band, covered, strayAt };
}
