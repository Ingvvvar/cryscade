import { describe, expect, it } from 'vitest';
import { SYMBOL_COUNT, type SymbolId } from '../../../src/core/model/symbols.ts';
import { SILHOUETTES } from '../../../src/render/art/silhouettes.ts';
import { iou, isSimple, rasterise, shoelace, toCommonScale, type Pt } from '../../support/polygon.ts';

// Тест силуэтов §9: символы различаются без цвета. Маски 64×64 из многоугольников; попарное IoU меньше 0.8
// как нарисованы и при общем масштабе — иначе «тот же силуэт, только меньше» прошёл бы за счёт размера.
const LIMIT = 0.8;
const symbols = Array.from({ length: SYMBOL_COUNT }, (_, i) => i as SymbolId);

function pairs(masks: readonly Uint8Array[]): { pair: string; value: number }[] {
  const out: { pair: string; value: number }[] = [];
  masks.forEach((a, i) => {
    masks.forEach((b, j) => {
      if (j > i) out.push({ pair: `${String(i)}–${String(j)}`, value: iou(a, b) });
    });
  });
  return out;
}

function worst(polygons: readonly (readonly Pt[])[]): { pairs: number; max: number; pair: string } {
  const all = pairs(polygons.map((polygon) => rasterise(polygon)));
  const top = all.reduce((a, b) => (b.value > a.value ? b : a), { pair: '', value: -1 });
  return { pairs: all.length, max: top.value, pair: top.pair };
}

describe('силуэты символов', () => {
  const polygons = symbols.map((symbol) => SILHOUETTES[symbol]);

  it('восемь силуэтов, у каждого вершины внутри [−1, 1]', () => {
    expect(polygons).toHaveLength(8);
    for (const [symbol, polygon] of polygons.entries()) {
      expect(polygon.length, String(symbol)).toBeGreaterThanOrEqual(3);
      for (const p of polygon) {
        expect(Math.abs(p.x), String(symbol)).toBeLessThanOrEqual(0.99);
        expect(Math.abs(p.y), String(symbol)).toBeLessThanOrEqual(0.99);
      }
    }
  });

  it('каждый — простой многоугольник, обход по часовой стрелке на экране', () => {
    for (const [symbol, polygon] of polygons.entries()) {
      expect(isSimple(polygon), String(symbol)).toBe(true);
      expect(shoelace(polygon), String(symbol)).toBeGreaterThan(0);
    }
  });

  it(`как нарисованы: попарное IoU меньше ${String(LIMIT)}`, () => {
    const result = worst(polygons);
    expect(result.pairs).toBe(28);
    expect(result.max, `худшая пара ${result.pair}`).toBeLessThan(LIMIT);
  });

  it(`при общем масштабе: попарное IoU меньше ${String(LIMIT)}`, () => {
    const result = worst(polygons.map(toCommonScale));
    expect(result.pairs).toBe(28);
    expect(result.max, `худшая пара ${result.pair}`).toBeLessThan(LIMIT);
  });
});

describe('инструмент IoU ловит одинаковые силуэты', () => {
  const ruby = SILHOUETTES[5];

  it('копия силуэта — IoU 1 в обоих режимах', () => {
    expect(worst([ruby, ruby]).max).toBe(1);
    expect(worst([ruby, ruby].map(toCommonScale)).max).toBe(1);
  });

  it('та же форма, только меньше: как нарисованы проходит, общий масштаб ловит', () => {
    const smaller = ruby.map((p) => ({ x: p.x * 0.8, y: p.y * 0.8 }));
    expect(worst([ruby, smaller]).max).toBeLessThan(LIMIT);
    expect(worst([ruby, smaller].map(toCommonScale)).max).toBeGreaterThan(0.95);
  });
});
