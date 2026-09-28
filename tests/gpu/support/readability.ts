// Читаемость по пикселям реального кадра (§15, фаза 3), как в Duskwing: без зависимостей, яркость WCAG.
// Клетка ищется по геометрии — прямоугольник от зонда, силуэт символа из art/silhouettes.ts, — а не по цвету.
// Тело символа — силуэт, сжатый на 3 единицы; подложка — скруглённый прямоугольник подложки без силуэта,
// расширенного на 4 единицы (обводка и края). Контраст — медиана тела против p95 подложки: отсветы и кромка
// подложки играют против символа. Неразобранная клетка — провал, а не пропуск.

import type { SymbolId } from '../../../src/core/model/symbols.ts';
import { SYMBOL_RADIUS } from '../../../src/render/art/crystal.ts';
import { SILHOUETTES } from '../../../src/render/art/silhouettes.ts';
import type { Rect } from '../../../src/render/layout.ts';
import { contrast, luminance, type Image } from '../../support/png.ts';
import { insidePolygon, type Pt } from '../../support/polygon.ts';

/** WCAG 2.2, 1.4.11 «Нетекстовый контраст»: графический объект, нужный для понимания, — не меньше 3:1. */
export const MIN_CONTRAST = 3;
const BODY_ERODE = 3;
const RING_DILATE = 4;
/** Подложка отступает от клетки на 3 единицы; берём ещё 2 — мимо кромок подложки. */
const BACKING_INSET = 5;
const BACKING_RADIUS = 8;
export const MIN_PIXELS = 200;

export interface CellReading {
  readonly cell: number;
  readonly symbol: SymbolId;
  readonly body: number;
  readonly backing: number;
  readonly ratio: number;
  readonly bodyPixels: number;
  readonly ringPixels: number;
}

function segmentDistance(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - a.x - t * dx, py - a.y - t * dy);
}

function edgeDistance(polygon: readonly Pt[], x: number, y: number): number {
  let best = Number.POSITIVE_INFINITY;
  polygon.forEach((a, i) => {
    const b = polygon[(i + 1) % polygon.length] ?? a;
    best = Math.min(best, segmentDistance(x, y, a, b));
  });
  return best;
}

function insideRoundRect(x: number, y: number, left: number, top: number, right: number, bottom: number, radius: number): boolean {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.max(left + radius, Math.min(right - radius, x));
  const cy = Math.max(top + radius, Math.min(bottom - radius, y));
  return Math.hypot(x - cx, y - cy) <= radius;
}

/** Области клетки: тело символа и кольцо подложки; для каждого пикселя — индекс в картинке. */
export function cellRegions(image: Image, rect: Rect, symbol: SymbolId, unit: number): { body: number[]; ring: number[] } {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const polygon = SILHOUETTES[symbol].map((p) => ({ x: cx + p.x * SYMBOL_RADIUS * unit, y: cy + p.y * SYMBOL_RADIUS * unit }));
  const inset = BACKING_INSET * unit;
  const body: number[] = [];
  const ring: number[] = [];
  for (let py = Math.floor(rect.y); py < Math.ceil(rect.y + rect.height); py++) {
    for (let px = Math.floor(rect.x); px < Math.ceil(rect.x + rect.width); px++) {
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      const x = px + 0.5;
      const y = py + 0.5;
      const inside = insidePolygon(polygon, x, y);
      const distance = edgeDistance(polygon, x, y);
      const index = (py * image.width + px) * 4;
      if (inside && distance >= BODY_ERODE * unit) body.push(index);
      else if (
        !inside &&
        distance >= RING_DILATE * unit &&
        insideRoundRect(x, y, rect.x + inset, rect.y + inset, rect.x + rect.width - inset, rect.y + rect.height - inset, BACKING_RADIUS * unit)
      ) {
        ring.push(index);
      }
    }
  }
  return { body, ring };
}

function lum(image: Image, index: number): number {
  return luminance(image.rgba[index] ?? 0, image.rgba[index + 1] ?? 0, image.rgba[index + 2] ?? 0);
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
}

export function readCell(image: Image, cell: number, rect: Rect, symbol: SymbolId, unit: number): CellReading {
  const { body, ring } = cellRegions(image, rect, symbol, unit);
  const bodyL = quantile(
    body.map((i) => lum(image, i)),
    0.5,
  );
  const backingL = quantile(
    ring.map((i) => lum(image, i)),
    0.95,
  );
  return { cell, symbol, body: bodyL, backing: backingL, ratio: contrast(bodyL, backingL), bodyPixels: body.length, ringPixels: ring.length };
}

/** Копия кадра, где тело символа клетки закрашено цветом rgb — положительный контроль инструмента. */
export function repaintBody(image: Image, rect: Rect, symbol: SymbolId, unit: number, rgb: readonly [number, number, number]): Image {
  const rgba = new Uint8Array(image.rgba);
  for (const index of cellRegions(image, rect, symbol, unit).body) rgba.set(rgb, index);
  return { width: image.width, height: image.height, rgba };
}

/** Цвет пикселя подложки с медианной яркостью — «символ цвета подложки». */
export function backingColour(image: Image, rect: Rect, symbol: SymbolId, unit: number): [number, number, number] {
  const { ring } = cellRegions(image, rect, symbol, unit);
  const sorted = [...ring].sort((a, b) => lum(image, a) - lum(image, b));
  const index = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return [image.rgba[index] ?? 0, image.rgba[index + 1] ?? 0, image.rgba[index + 2] ?? 0];
}
