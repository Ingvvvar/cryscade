// ?renderer=webgl|webgpu работает и в проде (§10): нужен для проверки на телефоне. Принудительный выбор
// не откатывается: недоступен — видимая ошибка, а не тихая подмена. Без параметра — WebGPU с откатом на WebGL.

import type { RendererName } from '../render/renderer.ts';

export interface RendererChoice {
  readonly preference: readonly RendererName[];
  readonly forced: RendererName | null;
}

export function rendererChoice(search: string): RendererChoice {
  const value = new URLSearchParams(search).get('renderer');
  if (value === 'webgl' || value === 'webgpu') return { preference: [value], forced: value };
  return { preference: ['webgpu', 'webgl'], forced: null };
}

/** Текст ошибки запуска для игрока. */
export function rendererFailure(choice: RendererChoice): string {
  return choice.forced === null
    ? 'Графіка не запустилася: браузер не підтримує ні WebGPU, ні WebGL.'
    : `Рендерер ${choice.forced} недоступний на цьому пристрої.`;
}
