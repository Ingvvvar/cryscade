import { describe, expect, it } from 'vitest';
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
