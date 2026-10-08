import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CELL,
  DESIGNS,
  FRAME_BORDER,
  MAX_RESOLUTION,
  cellRect,
  computeLayout,
  renderResolution,
  toScreen,
  type Insets,
  type Rect,
} from '../../../src/render/layout.ts';

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

function expectRect(actual: Rect, expected: Rect): void {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
  expect(actual.width).toBeCloseTo(expected.width, 9);
  expect(actual.height).toBeCloseTo(expected.height, 9);
}

const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

describe('холсты дизайна §9', () => {
  const designs = Object.entries(DESIGNS);

  it('два холста: портрет 720×1280 и ландшафт 1280×720', () => {
    expect(designs.map(([name, d]) => [name, d.width, d.height])).toStrictEqual([
      ['portrait', 720, 1280],
      ['landscape', 1280, 720],
    ]);
  });

  it('клетка не меньше 84, сетка — ровно 7 клеток, рамка — сетка плюс край', () => {
    expect(CELL).toBeGreaterThanOrEqual(84);
    for (const [name, { zones }] of designs) {
      expect(zones.grid.width, name).toBe(7 * CELL);
      expect(zones.grid.height, name).toBe(7 * CELL);
      expectRect(zones.frame, {
        x: zones.grid.x - FRAME_BORDER,
        y: zones.grid.y - FRAME_BORDER,
        width: zones.grid.width + 2 * FRAME_BORDER,
        height: zones.grid.height + 2 * FRAME_BORDER,
      });
    }
  });

  it('зоны лежат в холсте и не пересекаются; сетка — внутри рамки', () => {
    for (const [name, design] of designs) {
      const canvas: Rect = { x: 0, y: 0, width: design.width, height: design.height };
      const zones = Object.entries(design.zones);
      expect(zones.length, name).toBeGreaterThan(0);
      for (const [zone, rect] of zones) expect(contains(canvas, rect), `${name}.${zone}`).toBe(true);
      const outer = zones.filter(([zone]) => zone !== 'grid');
      for (const [i, [a, ra]] of outer.entries()) {
        for (const [b, rb] of outer.slice(i + 1)) expect(overlap(ra, rb), `${name}: ${a} × ${b}`).toBe(false);
      }
      expect(contains(design.zones.frame, design.zones.grid), name).toBe(true);
    }
  });

  it('клетки: 0 — левый верх сетки, 48 — правый низ', () => {
    const { portrait } = DESIGNS;
    // Портрет: сетка в (66, 184); клетка 48 — ряд 6, колонка 6.
    expectRect(cellRect(portrait, 0), { x: 66, y: 184, width: 84, height: 84 });
    expectRect(cellRect(portrait, 48), { x: 570, y: 688, width: 84, height: 84 });
    expectRect(cellRect(portrait, 8), { x: 150, y: 268, width: 84, height: 84 });
  });
});

describe('computeLayout — литералы', () => {
  it('720×1280 без вырезов — портрет в масштабе 1', () => {
    const layout = computeLayout({ width: 720, height: 1280, insets: NO_INSETS });
    expect(layout.orientation).toBe('portrait');
    expect(layout.scale).toBe(1);
    expectRect(layout.stage, { x: 0, y: 0, width: 720, height: 1280 });
  });

  it('телефон 390×844 с вырезами 47 и 34: вписан по ширине, по высоте в центре безопасной области', () => {
    // Безопасная область 390×763 с y = 47; масштаб 390/720; высота холста 1280·390/720 = 693.33…;
    // по вертикали остаётся 763 − 693.33… = 69.66…, пополам — 34.83…
    const layout = computeLayout({ width: 390, height: 844, insets: { top: 47, right: 0, bottom: 34, left: 0 } });
    expect(layout.orientation).toBe('portrait');
    expect(layout.scale).toBeCloseTo(390 / 720, 12);
    expectRect(layout.safe, { x: 0, y: 47, width: 390, height: 763 });
    expectRect(layout.stage, { x: 0, y: 81.833333333333, width: 390, height: 693.333333333333 });
    expectRect(layout.viewport, { x: 0, y: 0, width: 390, height: 844 });
  });

  it('телефон боком 844×390 с вырезами по бокам: ландшафт, вписан по высоте', () => {
    // Безопасная область 750×369 с x = 47; масштаб 369/720 = 0.5125; ширина холста 656; (750 − 656)/2 = 47.
    const layout = computeLayout({ width: 844, height: 390, insets: { top: 0, right: 47, bottom: 21, left: 47 } });
    expect(layout.orientation).toBe('landscape');
    expect(layout.scale).toBeCloseTo(0.5125, 12);
    expectRect(layout.stage, { x: 94, y: 0, width: 656, height: 369 });
  });

  it('квадрат 1000×1000 — ландшафт, по вертикали в центре', () => {
    // Масштаб 1000/1280 = 0.78125; высота холста 562.5; (1000 − 562.5)/2 = 218.75.
    const layout = computeLayout({ width: 1000, height: 1000, insets: NO_INSETS });
    expect(layout.orientation).toBe('landscape');
    expectRect(layout.stage, { x: 0, y: 218.75, width: 1000, height: 562.5 });
  });

  it('сетка на экране: портрет 1440×2560 — масштаб 2, клетка 168 px', () => {
    const layout = computeLayout({ width: 1440, height: 2560, insets: NO_INSETS });
    expectRect(toScreen(layout, cellRect(layout.design, 0)), { x: 132, y: 368, width: 168, height: 168 });
  });

  it('нулевой вьюпорт (вкладка скрыта) и вырезы больше экрана — масштаб 0, без NaN', () => {
    for (const viewport of [
      { width: 0, height: 0, insets: NO_INSETS },
      { width: 100, height: 100, insets: { top: 80, right: 0, bottom: 80, left: 0 } },
    ]) {
      const layout = computeLayout(viewport);
      expect(layout.scale).toBe(0);
      expect(Object.values(layout.stage).length).toBeGreaterThan(0);
      for (const value of Object.values(layout.stage)) expect(Number.isFinite(value)).toBe(true);
    }
  });
});

const size = fc.double({ min: 120, max: 4000, noNaN: true });
const inset = fc.double({ min: 0, max: 60, noNaN: true });
const viewportArb = fc.record({
  width: size,
  height: size,
  insets: fc.record({ top: inset, right: inset, bottom: inset, left: inset }),
});

describe('computeLayout — свойства', () => {
  it('холст внутри безопасной области, пропорции дизайна, касается пары краёв, отступы поровну', () => {
    fc.assert(
      fc.property(viewportArb, (viewport) => {
        const { safe, stage, design, orientation } = computeLayout(viewport);
        const eps = 1e-9 * Math.max(viewport.width, viewport.height);
        const inside =
          stage.x >= safe.x - eps &&
          stage.y >= safe.y - eps &&
          stage.x + stage.width <= safe.x + safe.width + eps &&
          stage.y + stage.height <= safe.y + safe.height + eps;
        const aspect = Math.abs(stage.width * design.height - stage.height * design.width) <= eps * design.width;
        const touches = Math.abs(stage.width - safe.width) <= eps || Math.abs(stage.height - safe.height) <= eps;
        const centred =
          Math.abs(stage.x - safe.x - (safe.x + safe.width - stage.x - stage.width)) <= 2 * eps &&
          Math.abs(stage.y - safe.y - (safe.y + safe.height - stage.y - stage.height)) <= 2 * eps;
        const oriented = orientation === (safe.width >= safe.height ? 'landscape' : 'portrait');
        return inside && aspect && touches && centred && oriented;
      }),
    );
  });

  it('клетка на экране — CELL × масштаб, все 49 клеток внутри безопасной области', () => {
    fc.assert(
      fc.property(viewportArb, (viewport) => {
        const layout = computeLayout(viewport);
        const eps = 1e-9 * Math.max(viewport.width, viewport.height);
        for (let cell = 0; cell < 49; cell++) {
          const rect = toScreen(layout, cellRect(layout.design, cell));
          if (Math.abs(rect.width - CELL * layout.scale) > eps) return false;
          if (rect.x < layout.safe.x - eps || rect.y < layout.safe.y - eps) return false;
          if (rect.x + rect.width > layout.safe.x + layout.safe.width + eps) return false;
          if (rect.y + rect.height > layout.safe.y + layout.safe.height + eps) return false;
        }
        return true;
      }),
    );
  });
});

describe('разрешение рендерера', () => {
  it('не выше 2: DPR 3 телефона даёт 2, меньшие проходят как есть', () => {
    expect(MAX_RESOLUTION).toBe(2);
    expect([1, 1.5, 2, 2.625, 3].map(renderResolution)).toStrictEqual([1, 1.5, 2, 2, 2]);
  });

  it('масштаб браузера меньше 1 проходит; ноль, минус и не число — 1', () => {
    expect(renderResolution(0.75)).toBe(0.75);
    expect([0, -1, Number.NaN, Number.POSITIVE_INFINITY].map(renderResolution)).toStrictEqual([1, 1, 1, 1]);
  });
});
