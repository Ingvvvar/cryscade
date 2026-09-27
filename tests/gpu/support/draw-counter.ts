// Счётчик draw-call — init-скрипт теста, а не код игры: в бандле его нет ни в какой сборке.
// Считает вызовы на границе API: WebGL — draw*, WebGPU — draw* проходов и бандлов. Бандлы рендера
// переигрываются через executeBundles, и тогда счёт неполон — такой вызов отмечается отдельно.
// Функция сериализуется Playwright и выполняется в странице до её скриптов: внешних ссылок в ней нет.

export interface DrawCounts {
  gl: number;
  gpu: number;
  executeBundles: number;
}

export function installDrawCounter(): void {
  const counts: DrawCounts = { gl: 0, gpu: 0, executeBundles: 0 };
  (window as Window & { __drawCounts?: DrawCounts }).__drawCounts = counts;
  const wrap = (proto: object | undefined, names: readonly string[], bump: () => void): void => {
    if (proto === undefined) return;
    for (const name of names) {
      const original: unknown = Reflect.get(proto, name);
      if (typeof original !== 'function') continue;
      Reflect.set(proto, name, function (this: unknown, ...args: unknown[]): unknown {
        bump();
        const result: unknown = Reflect.apply(original, this, args);
        return result;
      });
    }
  };
  // Конструкторов может не быть (WebGPU в headless shell), поэтому — через необязательные поля.
  const scope = globalThis as {
    WebGL2RenderingContext?: { prototype: object };
    WebGLRenderingContext?: { prototype: object };
    GPURenderPassEncoder?: { prototype: object };
    GPURenderBundleEncoder?: { prototype: object };
  };
  const glDraws = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'];
  wrap(scope.WebGL2RenderingContext?.prototype, glDraws, () => (counts.gl += 1));
  wrap(scope.WebGLRenderingContext?.prototype, glDraws, () => (counts.gl += 1));
  const gpuDraws = ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'];
  wrap(scope.GPURenderPassEncoder?.prototype, gpuDraws, () => (counts.gpu += 1));
  wrap(scope.GPURenderBundleEncoder?.prototype, gpuDraws, () => (counts.gpu += 1));
  wrap(scope.GPURenderPassEncoder?.prototype, ['executeBundles'], () => (counts.executeBundles += 1));
}
