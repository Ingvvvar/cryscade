import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { firstGrid } from '../../../src/ui/fixture-grid.ts';
import { rendererChoice, rendererFailure } from '../../../src/ui/renderer-choice.ts';

describe('rendererChoice — ?renderer=', () => {
  it('без параметра — WebGPU с откатом на WebGL, не принудительно', () => {
    expect(rendererChoice('')).toStrictEqual({ preference: ['webgpu', 'webgl'], forced: null });
  });

  it('webgl и webgpu — ровно этот рендерер, без отката', () => {
    expect(rendererChoice('?renderer=webgl')).toStrictEqual({ preference: ['webgl'], forced: 'webgl' });
    expect(rendererChoice('?x=1&renderer=webgpu')).toStrictEqual({ preference: ['webgpu'], forced: 'webgpu' });
  });

  it('неизвестное значение — как без параметра; canvas не предлагается никогда', () => {
    expect(rendererChoice('?renderer=canvas')).toStrictEqual({ preference: ['webgpu', 'webgl'], forced: null });
  });

  it('ошибка принудительного выбора называет рендерер', () => {
    expect(rendererFailure(rendererChoice('?renderer=webgpu'))).toContain('webgpu');
  });
});

describe('firstGrid — сетка фикстуры', () => {
  const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../fixtures/rounds/${name}.json`, import.meta.url), 'utf8'));

  it('feature-start: 49 символов, есть все восемь — кадр среза годится для проверки читаемости', () => {
    const grid = firstGrid(read('feature-start'));
    expect(grid).toHaveLength(49);
    expect(new Set(grid).size).toBe(8);
  });

  it.each([
    ['не объект', 7],
    ['нет events', {}],
    ['первое событие — не fill', { events: [{ t: 'end', payX100: 0 }] }],
    ['48 клеток', { events: [{ t: 'fill', grid: Array.from({ length: 48 }, () => 0) }] }],
    ['символ вне 0…7', { events: [{ t: 'fill', grid: [...Array.from({ length: 48 }, () => 0), 8] }] }],
    ['дробный символ', { events: [{ t: 'fill', grid: [...Array.from({ length: 48 }, () => 0), 1.5] }] }],
  ])('испорченное — ошибка: %s', (_, round) => {
    expect(() => firstGrid(round)).toThrow(TypeError);
  });
});
