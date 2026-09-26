// Независимая геометрия для тестов арта: своя, не из src/render/art — тест не должен проверять код им же самим.

export interface Pt {
  readonly x: number;
  readonly y: number;
}

/** Правило чётности: луч вправо от точки пересекает границу нечётное число раз. */
export function insidePolygon(polygon: readonly Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Растр size × size по центрам пикселей квадрата [−1, 1]². */
export function rasterise(polygon: readonly Pt[], size = 64): Uint8Array {
  const mask = new Uint8Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const x = -1 + (2 * (col + 0.5)) / size;
      const y = -1 + (2 * (row + 0.5)) / size;
      mask[row * size + col] = insidePolygon(polygon, x, y) ? 1 : 0;
    }
  }
  return mask;
}

export function iou(a: Uint8Array, b: Uint8Array): number {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] ?? 0;
    const q = b[i] ?? 0;
    both += p & q;
    either += p | q;
  }
  return both / either;
}

/** Общий масштаб: рамка по центру, большая сторона — 1.96 (почти весь квадрат), пропорции сохраняются. */
export function toCommonScale(polygon: readonly Pt[]): Pt[] {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const k = 1.96 / Math.max(maxX - minX, maxY - minY);
  return polygon.map((p) => ({ x: (p.x - (minX + maxX) / 2) * k, y: (p.y - (minY + maxY) / 2) * k }));
}

/** Площадь со знаком по формуле шнурования; на экране (y вниз) обход по часовой стрелке положителен. */
export function shoelace(polygon: readonly Pt[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (a === undefined || b === undefined) continue;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Отрезки пересекаются во внутренних точках (касание концами не считается). */
function properlyIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Простой многоугольник: несмежные рёбра не пересекаются. */
export function isSimple(polygon: readonly Pt[]): boolean {
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const a = polygon[i];
      const b = polygon[(i + 1) % n];
      const c = polygon[j];
      const d = polygon[(j + 1) % n];
      if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
      if (properlyIntersect(a, b, c, d)) return false;
    }
  }
  return true;
}
