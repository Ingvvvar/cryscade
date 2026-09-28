import { describe, expect, it } from 'vitest';
import { SCATTER, SYMBOL_COUNT, type SymbolId } from '../../../src/core/model/symbols.ts';
import { CORE_RINGS, FACET_BANDS, OUTLINE, SHARD_RADIUS, SHARDS_PER_SYMBOL, SYMBOL_RADIUS, gradientBands, symbolArt } from '../../../src/render/art/crystal.ts';
import { CELL } from '../../../src/render/layout.ts';
import { insidePolygon, shoelace } from '../../support/polygon.ts';

const symbols = Array.from({ length: SYMBOL_COUNT }, (_, i) => i as SymbolId);

describe('арт символов', () => {
  it('семь огранённых кристаллов и Ядро-сфера', () => {
    expect(symbols.map((s) => symbolArt(s).kind)).toStrictEqual([
      'crystal',
      'crystal',
      'crystal',
      'crystal',
      'crystal',
      'crystal',
      'crystal',
      'core',
    ]);
    expect(symbolArt(SCATTER).kind).toBe('core');
  });

  it('обводка — 1.5 единицы цвета cave-0 (§9)', () => {
    expect(OUTLINE).toStrictEqual({ width: 1.5, color: 0x050814 });
  });

  it.each(symbols)('символ %i вместе с обводкой помещается в клетку', (symbol) => {
    const reach = Math.max(...symbolArt(symbol).silhouette.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
    expect(reach + OUTLINE.width / 2).toBeLessThanOrEqual(CELL / 2);
    // Квадрат Аметиста меньше остальных намеренно (silhouettes.ts), но не мельче 0.6 радиуса.
    expect(reach).toBeGreaterThan(SYMBOL_RADIUS * 0.6);
  });

  it.each(symbols)('символ %i: блики — внутри силуэта; кромка — на рёбрах, обращённых вверх', (symbol) => {
    const art = symbolArt(symbol);
    expect(art.glints.length).toBeGreaterThan(0);
    for (const glint of art.glints) expect(insidePolygon(art.silhouette, glint.x, glint.y)).toBe(true);
    expect(art.rim.length).toBeGreaterThan(0);
    for (const { from, to } of art.rim) expect(to.x).toBeGreaterThan(from.x);
  });

  it.each(symbols)('символ %i: три осколка, каждый внутри своего круга', (symbol) => {
    const { shards } = symbolArt(symbol);
    expect(shards).toHaveLength(SHARDS_PER_SYMBOL);
    for (const shard of shards) {
      expect(shard.points.length).toBeGreaterThanOrEqual(3);
      const reach = Math.max(...shard.points.map((p) => Math.hypot(p.x, p.y)));
      expect(reach).toBeCloseTo(SHARD_RADIUS, 9);
    }
  });

  it('у кристаллов верхние грани светлее нижних: свет сверху слева', () => {
    for (const symbol of symbols.filter((s) => s !== SCATTER)) {
      const art = symbolArt(symbol);
      if (art.kind !== 'crystal') continue;
      const crown = art.facets.slice(0, -1);
      const luma = (c: number): number => ((c >> 16) & 0xff) * 0.2126 + ((c >> 8) & 0xff) * 0.7152 + (c & 0xff) * 0.0722;
      const top = crown.filter((f) => f.outer.y < -SYMBOL_RADIUS * 0.4);
      const bottom = crown.filter((f) => f.outer.y > SYMBOL_RADIUS * 0.4);
      const mean = (list: typeof crown): number => list.reduce((s, f) => s + luma(f.innerColor), 0) / list.length;
      expect(top.length, String(symbol)).toBeGreaterThan(0);
      expect(bottom.length, String(symbol)).toBeGreaterThan(0);
      expect(mean(top), String(symbol)).toBeGreaterThan(mean(bottom) + 15);
    }
  });
});

const luma = (c: number): number => ((c >> 16) & 0xff) * 0.2126 + ((c >> 8) & 0xff) * 0.7152 + (c & 0xff) * 0.0722;

describe('градиент полосами', () => {
  it('квадрат 10×10 сверху вниз — четыре полосы по 25, цвет от верхнего к нижнему', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const bands = gradientBands(square, { x: 5, y: 0 }, { x: 5, y: 10 }, 0x000000, 0xffffff, 4);
    expect(bands.map((band) => Math.abs(shoelace(band.points)))).toStrictEqual([25, 25, 25, 25]);
    const lumas = bands.map((band) => luma(band.color));
    expect([...lumas].sort((a, b) => a - b)).toStrictEqual(lumas);
    expect(lumas[0]).toBeGreaterThan(0);
    expect(lumas[3]).toBeLessThan(255);
  });

  it.each(symbols)('символ %i: полосы каждой грани ровно покрывают грань', (symbol) => {
    const art = symbolArt(symbol);
    const facets = art.kind === 'crystal' ? art.facets : art.rays;
    for (const facet of facets) {
      expect(facet.bands.length).toBeGreaterThan(0);
      expect(facet.bands.length).toBeLessThanOrEqual(FACET_BANDS);
      const sum = facet.bands.reduce((total, band) => total + Math.abs(shoelace(band.points)), 0);
      expect(sum).toBeCloseTo(Math.abs(shoelace(facet.points)), 6);
    }
  });

  it('сфера Ядра: круги от края к центру, светлеют к центру', () => {
    const art = symbolArt(SCATTER);
    if (art.kind !== 'core') throw new Error('Ядро — сфера');
    const { rings, radius } = art.body;
    expect(rings).toHaveLength(CORE_RINGS);
    expect(rings[0]?.radius).toBeCloseTo(radius, 9);
    for (let i = 1; i < rings.length; i++) {
      expect(rings[i]?.radius ?? 0).toBeLessThan(rings[i - 1]?.radius ?? 0);
      expect(luma(rings[i]?.color ?? 0)).toBeGreaterThanOrEqual(luma(rings[i - 1]?.color ?? 0));
    }
  });
});

