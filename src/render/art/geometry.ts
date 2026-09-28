// Плоская геометрия арта. Ось y вниз, как на экране.

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function unit3(x: number, y: number, z: number): Vec3 {
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
}

export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Точка по направлению: угол от «вверх» по часовой стрелке. */
export function polar(radius: number, angle: number, cx = 0, cy = 0): Point {
  return { x: cx + radius * Math.sin(angle), y: cy - radius * Math.cos(angle) };
}

/** Правильный многоугольник; первая вершина — под углом rotation от «вверх». */
export function regular(sides: number, radius: number, rotation = 0): Point[] {
  return Array.from({ length: sides }, (_, i) => polar(radius, rotation + (i * 2 * Math.PI) / sides));
}

/** Срез каждого угла на cut вдоль обоих прилежащих рёбер. */
export function chamfer(points: readonly Point[], cut: number): Point[] {
  const out: Point[] = [];
  const n = points.length;
  points.forEach((p, i) => {
    for (const q of [points[(i + n - 1) % n], points[(i + 1) % n]]) {
      if (q === undefined) continue;
      const k = cut / Math.hypot(q.x - p.x, q.y - p.y);
      out.push({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
    }
  });
  return out;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function bounds(points: readonly Point[]): Bounds {
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

/** Сдвиг: центр рамки — в (0, 0). */
export function centreBounds(points: readonly Point[]): Point[] {
  const b = bounds(points);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return points.map((p) => ({ x: p.x - cx, y: p.y - cy }));
}

/** Площадь со знаком: на экране (y вниз) обход по часовой стрелке положителен. */
export function signedArea(points: readonly Point[]): number {
  let sum = 0;
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length] ?? p;
    sum += p.x * q.y - q.x * p.y;
  });
  return sum / 2;
}

/** Центр масс многоугольника. */
export function centroid(points: readonly Point[]): Point {
  let cx = 0;
  let cy = 0;
  let twice = 0;
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length] ?? p;
    const cross = p.x * q.y - q.x * p.y;
    twice += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  });
  return { x: cx / (3 * twice), y: cy / (3 * twice) };
}

/** Каждое ребро делится на parts равных отрезков. */
export function subdivide(points: readonly Point[], parts: number): Point[] {
  const out: Point[] = [];
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length] ?? p;
    for (let k = 0; k < parts; k++) out.push({ x: p.x + ((q.x - p.x) * k) / parts, y: p.y + ((q.y - p.y) * k) / parts });
  });
  return out;
}

export function scalePoints(points: readonly Point[], factor: number): Point[] {
  return points.map((p) => ({ x: p.x * factor, y: p.y * factor }));
}

/**
 * Отсечение полуплоскостью (Сазерленд — Ходжмен, одна плоскость): остаётся часть, где nx·x + ny·y ≤ limit.
 * Годится и для невыпуклого многоугольника: площадь части сохраняется, лишь бы шов был по прямой.
 */
export function clipHalfPlane(points: readonly Point[], nx: number, ny: number, limit: number): Point[] {
  const out: Point[] = [];
  const side = (p: Point): number => nx * p.x + ny * p.y - limit;
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length] ?? a;
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  });
  return out;
}

