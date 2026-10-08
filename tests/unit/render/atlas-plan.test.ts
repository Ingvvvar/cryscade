import { describe, expect, it } from 'vitest';
import { ATLAS_MAX_SIZE, ATLAS_PADDING, atlasEntries, planAtlas, type AtlasFrame } from '../../../src/render/art/atlas-plan.ts';

// План атласа §9, §13: всё в одной текстуре не больше 2048×2048, кадры не пересекаются и разделены полями.

const gapBetween = (a: AtlasFrame, b: AtlasFrame): number =>
  Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height));

describe('план атласа', () => {
  const entries = atlasEntries();
  const plan = planAtlas(entries);

  it('состав: 8 символов, 8 свечений, 24 осколка, 4 подложки, рамка, блик, звезда, точка; фаза 5 — кромки, плашка, замок, панель', () => {
    const keys = entries.map((entry) => entry.key);
    expect(keys).toHaveLength(53);
    expect(new Set(keys).size).toBe(53);
    expect(keys.filter((key) => key.startsWith('symbol-'))).toHaveLength(8);
    expect(keys.filter((key) => key.startsWith('glow-'))).toHaveLength(8);
    expect(keys.filter((key) => key.startsWith('shard-'))).toHaveLength(24);
    expect(keys).toEqual(expect.arrayContaining(['backing', 'backing-lit', 'backing-iridescent', 'mark', 'frame-slice', 'glint-streak', 'star', 'dot']));
    expect(keys).toEqual(expect.arrayContaining(['rim', 'rim-iridescent', 'chip', 'lock', 'panel']));
  });

  it('каждый ключ — ровно один кадр размером с запись × разрешение', () => {
    expect(plan.frames.map((f) => f.key).sort()).toStrictEqual(entries.map((e) => e.key).sort());
    expect(plan.frames.length).toBeGreaterThan(0);
    for (const frame of plan.frames) {
      const entry = entries.find((e) => e.key === frame.key);
      expect(frame.width).toBe(Math.ceil((entry?.width ?? 0) * plan.resolution));
      expect(frame.height).toBe(Math.ceil((entry?.height ?? 0) * plan.resolution));
    }
  });

  it('разрешение 2×; атлас не больше 2048×2048, высота — степень двойки', () => {
    expect(plan.resolution).toBe(2);
    expect(plan.width).toBeLessThanOrEqual(ATLAS_MAX_SIZE);
    expect(plan.height).toBeLessThanOrEqual(ATLAS_MAX_SIZE);
    expect(Math.log2(plan.height) % 1).toBe(0);
  });

  it('кадры в целых пикселях, внутри атласа с полем от края, между собой — не ближе поля', () => {
    for (const frame of plan.frames) {
      for (const v of [frame.x, frame.y, frame.width, frame.height]) expect(Number.isInteger(v)).toBe(true);
      expect(frame.x).toBeGreaterThanOrEqual(ATLAS_PADDING);
      expect(frame.y).toBeGreaterThanOrEqual(ATLAS_PADDING);
      expect(frame.x + frame.width).toBeLessThanOrEqual(plan.width - ATLAS_PADDING);
      expect(frame.y + frame.height).toBeLessThanOrEqual(plan.height - ATLAS_PADDING);
    }
    let checked = 0;
    plan.frames.forEach((a, i) => {
      plan.frames.slice(i + 1).forEach((b) => {
        expect(gapBetween(a, b), `${a.key} × ${b.key}`).toBeGreaterThanOrEqual(ATLAS_PADDING);
        checked += 1;
      });
    });
    expect(checked).toBe((53 * 52) / 2);
  });

  it('детерминирован: повторный план совпадает', () => {
    expect(planAtlas(atlasEntries())).toStrictEqual(plan);
  });

  it('не влезает — ошибка, а не обрезка', () => {
    expect(() => planAtlas([{ key: 'dot', width: 2000, height: 10 }])).toThrow(RangeError);
    expect(() => planAtlas(entries, 2, 512)).toThrow(RangeError);
  });
});
