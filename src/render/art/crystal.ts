// Арт символа — простые данные для выпечки атласа (§9 «Огранка — процедурно»): грани с цветами и градиентом,
// светлая кромка сверху, блики-звёзды на верхних гранях, тёмная обводка 1.5, осколки для частиц.
// Ядро — не огранённый кристалл, а светящаяся сфера с лучами. Единицы — дизайна, центр символа в (0, 0).

import { SCATTER, SYMBOL, type SymbolId } from '../../core/model/symbols.ts';
import { brighten, mix } from './color.ts';
import { cutFacets, type CutOptions, type FacetShape } from './facets.ts';
import { centroid, clipHalfPlane, dot3, scalePoints, signedArea, type Point } from './geometry.ts';
import { LIGHTING, shade } from './light.ts';
import { DISPERSION, PALETTE, SYMBOL_COLORS } from './palette.ts';
import { SILHOUETTES } from './silhouettes.ts';

/** Радиус силуэта в единицах дизайна: символ ≈ 70 единиц в клетке 84. */
export const SYMBOL_RADIUS = 36;
/** Тёмная обводка (§9): отделяет кристалл от любого фона. */
export const OUTLINE = { width: 1.5, color: PALETTE.cave0 } as const;
/** Осколок вписан в круг такого радиуса. */
export const SHARD_RADIUS = 10;
export const SHARDS_PER_SYMBOL = 3;

type CrystalId = Exclude<SymbolId, typeof SCATTER>;

export const CUTS: Readonly<Record<CrystalId, CutOptions>> = {
  [SYMBOL.quartz]: { tableScale: 0.5, tableLift: 0.06, tilt: 0.75, subdivide: 2 },
  [SYMBOL.amethyst]: { tableScale: 0.52, tableLift: 0.05, tilt: 0.7, subdivide: 2 },
  [SYMBOL.citrine]: { tableScale: 0.5, tableLift: 0.06, tilt: 0.72, subdivide: 2 },
  [SYMBOL.emerald]: { tableScale: 0.55, tableLift: 0.04, tilt: 0.62, subdivide: 1 },
  [SYMBOL.sapphire]: { tableScale: 0.48, tableLift: 0.07, tilt: 0.8, subdivide: 1 },
  [SYMBOL.ruby]: { tableScale: 0.48, tableLift: 0.06, tilt: 0.78, subdivide: 1 },
  [SYMBOL.diamond]: { tableScale: 0.45, tableLift: 0.05, tilt: 0.82, subdivide: 3 },
};

/** Полоса градиента: часть грани плоским цветом. */
export interface Band {
  readonly points: readonly Point[];
  readonly color: number;
}

interface FacetArt {
  readonly points: readonly Point[];
  /** Градиент грани: от внешнего ребра к внутреннему. */
  readonly outer: Point;
  readonly inner: Point;
  readonly outerColor: number;
  readonly innerColor: number;
  /** Тот же градиент полосами поперёк направления outer → inner: выпекается без текстур градиента. */
  readonly bands: readonly Band[];
}

/** Полос на грань: лёгкий градиент (§9) без текстур FillGradient — их нельзя уничтожить без предупреждения WebGPU. */
export const FACET_BANDS = 4;
/** Кругов в радиальном градиенте сферы Ядра. */
export const CORE_RINGS = 12;

/**
 * Многоугольник режется на count полос поперёк направления from → to; крайние полосы открыты наружу, так что
 * полосы вместе ровно покрывают многоугольник. Цвет полосы — смесь в линейном пространстве в её середине.
 */
export function gradientBands(points: readonly Point[], from: Point, to: Point, fromColor: number, toColor: number, count: number): Band[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length2 = dx * dx + dy * dy;
  const base = dx * from.x + dy * from.y;
  const bands: Band[] = [];
  for (let k = 0; k < count; k++) {
    let part: Point[] = [...points];
    if (k > 0) part = clipHalfPlane(part, -dx, -dy, -(base + (k / count) * length2));
    if (k < count - 1) part = clipHalfPlane(part, dx, dy, base + ((k + 1) / count) * length2);
    if (part.length >= 3 && Math.abs(signedArea(part)) > 1e-9) bands.push({ points: part, color: mix(fromColor, toColor, (k + 0.5) / count) });
  }
  return bands;
}

interface Glint {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export interface Segment {
  readonly from: Point;
  readonly to: Point;
}

interface Shard {
  /** Вокруг своего центра масс, внутри круга SHARD_RADIUS. */
  readonly points: readonly Point[];
  readonly color: number;
}

interface ArtCommon {
  readonly symbol: SymbolId;
  readonly silhouette: readonly Point[];
  /** Светлая кромка: рёбра силуэта, обращённые вверх. */
  readonly rim: readonly Segment[];
  readonly rimColor: number;
  readonly glints: readonly Glint[];
  readonly shards: readonly Shard[];
}

export interface CrystalArt extends ArtCommon {
  readonly kind: 'crystal';
  readonly facets: readonly FacetArt[];
}

interface GradientStop {
  readonly offset: number;
  readonly color: number;
}

export interface CoreArt extends ArtCommon {
  readonly kind: 'core';
  /** rings — радиальный градиент стопкой кругов от края к центру: выпекается без текстуры градиента. */
  readonly body: { readonly radius: number; readonly stops: readonly GradientStop[]; readonly rings: readonly { readonly radius: number; readonly color: number }[] };
  readonly rays: readonly FacetArt[];
}

/** Цвет градиента по остановкам в точке offset ∈ [0, 1]. */
function colorAt(stops: readonly GradientStop[], offset: number): number {
  const first = stops[0];
  if (first === undefined) throw new RangeError('градиент без остановок');
  let previous = first;
  for (const stop of stops) {
    if (offset <= stop.offset) {
      const span = stop.offset - previous.offset;
      return span <= 0 ? stop.color : mix(previous.color, stop.color, (offset - previous.offset) / span);
    }
    previous = stop;
  }
  return previous.color;
}

export type SymbolArt = CrystalArt | CoreArt;

/** Рёбра, чья внешняя нормаль смотрит вверх, — под светлую кромку. */
function upperEdges(points: readonly Point[]): Segment[] {
  return points.flatMap((from, i) => {
    const to = points[(i + 1) % points.length] ?? from;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    return -(to.x - from.x) / length < -0.35 ? [{ from, to }] : [];
  });
}

function shardOf(points: readonly Point[], color: number): Shard {
  const c = centroid(points);
  const local = points.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
  const reach = Math.max(...local.map((p) => Math.hypot(p.x, p.y)));
  return { points: scalePoints(local, SHARD_RADIUS / reach), color };
}

function pickShards<T>(items: readonly T[]): T[] {
  return [1, 3, 5].flatMap((k) => {
    const item = items[Math.floor((k * items.length) / (2 * SHARDS_PER_SYMBOL))];
    return item === undefined ? [] : [item];
  });
}

function crystal(symbol: CrystalId): CrystalArt {
  const silhouette = scalePoints(SILHOUETTES[symbol], SYMBOL_RADIUS);
  const albedo = SYMBOL_COLORS[symbol];
  const shapes = cutFacets(silhouette, { ...CUTS[symbol], tableLift: CUTS[symbol].tableLift * SYMBOL_RADIUS });
  const facets = shapes.map((shape, i): FacetArt => {
    let base = shade(albedo, shape.normal);
    if (symbol === SYMBOL.diamond && !shape.table) base = mix(base, DISPERSION[i % DISPERSION.length] ?? base, 0.2);
    const outerColor = brighten(base, 0.8);
    const innerColor = brighten(base, 1.12);
    return {
      points: shape.points,
      outer: shape.outer,
      inner: shape.inner,
      outerColor,
      innerColor,
      bands: gradientBands(shape.points, shape.outer, shape.inner, outerColor, innerColor, FACET_BANDS),
    };
  });
  // Блики — на двух гранях, сильнее всех повёрнутых к ключевому свету.
  const lit = shapes
    .filter((shape) => !shape.table)
    .map((shape: FacetShape) => ({ shape, light: dot3(shape.normal, LIGHTING.key.direction) }))
    .sort((a, b) => b.light - a.light)
    .slice(0, 2);
  const glints = lit.map(({ shape }, i) => ({ ...centroid(shape.points), size: i === 0 ? 7 : 4.5 }));
  const crown = facets.filter((_, i) => !(shapes[i]?.table ?? true));
  return {
    kind: 'crystal',
    symbol,
    silhouette,
    facets,
    rim: upperEdges(silhouette),
    rimColor: mix(albedo, 0xffffff, 0.75),
    glints,
    shards: pickShards(crown).map((facet) => shardOf(facet.points, mix(facet.outerColor, facet.innerColor, 0.5))),
  };
}

function core(): CoreArt {
  const silhouette = scalePoints(SILHOUETTES[SCATTER], SYMBOL_RADIUS);
  const glow = SYMBOL_COLORS[SCATTER];
  // Силуэт Ядра — по четыре точки на луч: основание, остриё, основание, дуга между лучами.
  const rays: FacetArt[] = [];
  for (let k = 0; k + 2 < silhouette.length; k += 4) {
    const left = silhouette[k];
    const tip = silhouette[k + 1];
    const right = silhouette[k + 2];
    if (left === undefined || tip === undefined || right === undefined) continue;
    const points = [left, tip, right, { x: 0, y: 0 }];
    const inner = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
    const outerColor = mix(glow, 0xffffff, 0.15);
    const innerColor = mix(glow, 0xffffff, 0.7);
    rays.push({ points, outer: tip, inner, outerColor, innerColor, bands: gradientBands(points, tip, inner, outerColor, innerColor, FACET_BANDS) });
  }
  const bodyRadius = Math.min(...silhouette.map((p) => Math.hypot(p.x, p.y)));
  const stops: GradientStop[] = [
    { offset: 0, color: 0xffffff },
    { offset: 0.45, color: mix(0xffffff, glow, 0.35) },
    { offset: 1, color: brighten(glow, 0.7) },
  ];
  // Круг k покрывает радиус (k + 1)/CORE_RINGS; цвет — в середине своего кольца.
  const rings = Array.from({ length: CORE_RINGS }, (_, i) => {
    const k = CORE_RINGS - 1 - i;
    return { radius: (bodyRadius * (k + 1)) / CORE_RINGS, color: colorAt(stops, (k + 0.5) / CORE_RINGS) };
  });
  return {
    kind: 'core',
    symbol: SCATTER,
    silhouette,
    body: { radius: bodyRadius, stops, rings },
    rays,
    rim: upperEdges(silhouette),
    rimColor: mix(glow, 0xffffff, 0.8),
    glints: [{ x: -bodyRadius * 0.35, y: -bodyRadius * 0.4, size: 7 }],
    shards: pickShards(rays).map((ray) => shardOf(ray.points.slice(0, 3), ray.outerColor)),
  };
}

export function symbolArt(symbol: SymbolId): SymbolArt {
  return symbol === SCATTER ? core() : crystal(symbol);
}
