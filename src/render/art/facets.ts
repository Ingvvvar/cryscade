// Огранка §9: площадка — силуэт, уменьшенный к центру масс и чуть поднятый; грани — четырёхугольники между
// ребром силуэта и соответствующим ребром площадки. У грани фиктивная нормаль: наружу от ребра с наклоном tilt.

import { centroid, signedArea, subdivide, type Point, type Vec3 } from './geometry.ts';

export interface CutOptions {
  /** Площадка — во столько раз меньше силуэта (§9: 0.45–0.55). */
  readonly tableScale: number;
  /** Подъём площадки вверх, в единицах силуэта. */
  readonly tableLift: number;
  /** Наклон граней от плоскости экрана, радианы. */
  readonly tilt: number;
  /** На сколько частей делится каждое ребро силуэта: больше граней — мельче огранка. */
  readonly subdivide: number;
}

export interface FacetShape {
  readonly points: readonly Point[];
  readonly normal: Vec3;
  /** Середина внешнего ребра и середина внутреннего: вдоль них идёт градиент грани. */
  readonly outer: Point;
  readonly inner: Point;
  readonly table: boolean;
}

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Силуэт обходится по часовой стрелке на экране; последняя грань — площадка. */
export function cutFacets(silhouette: readonly Point[], options: CutOptions): FacetShape[] {
  const ordered = signedArea(silhouette) >= 0 ? silhouette : [...silhouette].reverse();
  const outer = subdivide(ordered, options.subdivide);
  const centre = centroid(outer);
  const inner = outer.map((p) => ({
    x: centre.x + (p.x - centre.x) * options.tableScale,
    y: centre.y + (p.y - centre.y) * options.tableScale - options.tableLift,
  }));
  const sin = Math.sin(options.tilt);
  const cos = Math.cos(options.tilt);
  const facets: FacetShape[] = outer.map((a, i) => {
    const next = (i + 1) % outer.length;
    const b = outer[next] ?? a;
    const ia = inner[i] ?? a;
    const ib = inner[next] ?? b;
    // Наружу от ребра при обходе по часовой стрелке с осью y вниз: (ey, −ex).
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = (b.y - a.y) / length;
    const ny = -(b.x - a.x) / length;
    return {
      points: [a, b, ib, ia],
      normal: { x: nx * sin, y: ny * sin, z: cos },
      outer: midpoint(a, b),
      inner: midpoint(ia, ib),
      table: false,
    };
  });
  const top = Math.min(...inner.map((p) => p.y));
  const bottom = Math.max(...inner.map((p) => p.y));
  const tableCentre = centroid(inner);
  facets.push({
    points: inner,
    normal: { x: 0, y: 0, z: 1 },
    outer: { x: tableCentre.x, y: top },
    inner: { x: tableCentre.x, y: bottom },
    table: true,
  });
  return facets;
}
