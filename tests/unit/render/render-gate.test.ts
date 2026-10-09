import { describe, expect, it } from 'vitest';
import { RenderGate } from '../../../src/render/render-gate.ts';

// Ворота отрисовки (§10): по требованию — эконом-режим без GPU, порог — зонд e2e при программном рендере. Ожидания —
// счётом кадров по 16 мс руками: порог 1000 мс выходит на 63-м кадре после отрисовки (63 · 16 = 1008).

function drawn(gate: RenderGate, frames: number, elapsedMs = 16): boolean[] {
  return Array.from({ length: frames }, () => gate.frame(elapsedMs));
}

describe('RenderGate: каждый кадр', () => {
  it('без требования и порога — рисуется каждый кадр, как render Pixi на тикере', () => {
    expect(drawn(new RenderGate(false), 4)).toStrictEqual([true, true, true, true]);
  });
});

describe('RenderGate: по требованию', () => {
  it('первый кадр рисуется сразу, дальше — только после invalidate, по одному кадру на изменение', () => {
    const gate = new RenderGate(true);
    const frames = drawn(gate, 3);
    gate.invalidate();
    gate.invalidate();
    frames.push(...drawn(gate, 3));
    expect(frames).toStrictEqual([true, false, false, true, false, false]);
  });

  it('покой — ни одного кадра за 300 кадров тикера', () => {
    const gate = new RenderGate(true);
    gate.frame(16);
    expect(drawn(gate, 300).filter(Boolean)).toHaveLength(0);
  });
});

describe('RenderGate: порог', () => {
  it('порог 1000 мс без требования — кадры 1, 64, 127, 190, 253 из 300 по 16 мс', () => {
    const gate = new RenderGate(false);
    gate.throttle(1000);
    const frames = drawn(gate, 300);
    expect(frames.flatMap((on, index) => (on ? [index + 1] : []))).toStrictEqual([1, 64, 127, 190, 253]);
  });

  it('порог откладывает, но не теряет: изменённый кадр рисуется, как только порог вышел, и один', () => {
    const gate = new RenderGate(true);
    gate.throttle(1000);
    expect(gate.frame(16)).toBe(true);
    gate.invalidate();
    const frames = drawn(gate, 130);
    expect(frames.flatMap((on, index) => (on ? [index + 1] : []))).toStrictEqual([63]);
  });

  it('по требованию и с порогом: показ меняет кадр каждый тик — рисуется раз в секунду', () => {
    const gate = new RenderGate(true);
    gate.throttle(1000);
    const frames: boolean[] = [];
    for (let k = 0; k < 300; k++) {
      gate.invalidate();
      frames.push(gate.frame(16));
    }
    expect(frames.flatMap((on, index) => (on ? [index + 1] : []))).toStrictEqual([1, 64, 127, 190, 253]);
  });

  it('порог 0 — снова каждый кадр; порог — конечное неотрицательное число', () => {
    const gate = new RenderGate(false);
    gate.throttle(1000);
    gate.frame(16);
    gate.throttle(0);
    expect(drawn(gate, 3)).toStrictEqual([true, true, true]);
    expect(() => {
      gate.throttle(-1);
    }).toThrow(RangeError);
    expect(() => {
      gate.throttle(Number.NaN);
    }).toThrow(RangeError);
    expect(() => {
      gate.throttle(Number.POSITIVE_INFINITY);
    }).toThrow(RangeError);
  });
});
