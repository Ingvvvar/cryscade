// Программный рендер (§10, эконом-режим): строка рендерера без аппаратного ускорения. Имена программных растеризаторов
// в строках браузеров: SwiftShader — Chrome без GPU (ANGLE поверх Vulkan), llvmpipe и softpipe — Mesa, Microsoft Basic
// Render Driver — WARP в Windows без драйвера видеокарты; «software» — общее слово (Mesa «Software Rasterizer»).
// У WebGPU есть и прямой признак — резервный адаптер (isFallbackAdapter). Список закреплён юнит-тестом на литералах.

export const SOFTWARE_RENDERERS: readonly string[] = ['swiftshader', 'llvmpipe', 'softpipe', 'microsoft basic render driver', 'software'];

/** Строка рендерера — программная: в ней есть имя из списка, регистр не важен. */
export function isSoftwareRenderer(gpu: string): boolean {
  const name = gpu.toLowerCase();
  return SOFTWARE_RENDERERS.some((part) => name.includes(part));
}
