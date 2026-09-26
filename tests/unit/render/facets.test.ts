import { describe, expect, it } from 'vitest';
import { SYMBOL } from '../../../src/core/model/symbols.ts';
import { CUTS } from '../../../src/render/art/crystal.ts';
import { cutFacets } from '../../../src/render/art/facets.ts';
import { SILHOUETTES } from '../../../src/render/art/silhouettes.ts';
import { insidePolygon, isSimple, shoelace, type Pt } from '../../support/polygon.ts';

// Огранка §9: площадка — внутренний многоугольник в 0.45–0.55 от внешнего, чуть выше центра;
// грани — четырёхугольники между ребром силуэта и ребром площадки. Геометрию проверяет своя геометрия теста.

const crystals = Object.entries(CUTS).map(([id, cut]) => {
  const symbol = Number(id) as keyof typeof CUTS;
  return { symbol, cut, silhouette: SILHOUETTES[symbol] };
});

function centreOfMass(polygon: readonly Pt[]): Pt {
  let x = 0;
  let y = 0;
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (a === undefined || b === undefined) continue;
    const c = a.x * b.y - b.x * a.y;
    twice += c;
    x += (a.x + b.x) * c;
    y += (a.y + b.y) * c;
  }
  return { x: x / (3 * twice), y: y / (3 * twice) };
}

describe('огранка', () => {
  it('огранены семь кристаллов — все символы, кроме Ядра', () => {
    expect(crystals.map((c) => c.symbol).sort()).toStrictEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(crystals.map((c) => c.symbol)).not.toContain(SYMBOL.core);
  });

  it.each(crystals.map((c) => [c.symbol, c] as const))('символ %i: грани и площадка ровно замощают силуэт', (_, { silhouette, cut }) => {
    const facets = cutFacets(silhouette, cut);
    expect(facets).toHaveLength(silhouette.length * cut.subdivide + 1);
    const total = shoelace(silhouette);
    let sum = 0;
    for (const facet of facets) {
      const area = shoelace(facet.points);
      expect(area).toBeGreaterThan(0);
      expect(isSimple(facet.points)).toBe(true);
      sum += area;
    }
    expect(sum).toBeCloseTo(total, 9);
  });

  it.each(crystals.map((c) => [c.symbol, c] as const))('символ %i: площадка внутри силуэта, в 0.45–0.55 от него и выше центра', (_, { silhouette, cut }) => {
    const facets = cutFacets(silhouette, cut);
    const table = facets.at(-1);
    expect(table?.table).toBe(true);
    const points = table?.points ?? [];
    for (const p of points) expect(insidePolygon(silhouette, p.x, p.y)).toBe(true);
    const linear = Math.sqrt(shoelace(points) / shoelace(silhouette));
    expect(linear).toBeGreaterThanOrEqual(0.45);
    expect(linear).toBeLessThanOrEqual(0.55);
    expect(centreOfMass(points).y).toBeLessThan(centreOfMass(silhouette).y);
  });

  it.each(crystals.map((c) => [c.symbol, c] as const))('символ %i: нормали единичные; грани смотрят наружу, площадка — на зрителя', (_, { silhouette, cut }) => {
    const facets = cutFacets(silhouette, cut);
    const centre = centreOfMass(silhouette);
    for (const facet of facets) {
      const { x, y, z } = facet.normal;
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
      if (facet.table) {
        expect([x, y, z]).toStrictEqual([0, 0, 1]);
        continue;
      }
      expect(z).toBeGreaterThan(0);
      expect(x * (facet.outer.x - centre.x) + y * (facet.outer.y - centre.y)).toBeGreaterThan(0);
    }
  });
});
