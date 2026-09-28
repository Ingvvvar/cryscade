// Счётчик созданных конвейеров — init-скрипт теста: WebGPU — createRenderPipeline(Async), WebGL — linkProgram.
// По событию «сцена готова» (зонд, dev и e2e-сборка) запоминает, сколько было до него. Внешних ссылок нет:
// функцию сериализует Playwright.

export interface PipelineCounts {
  total: number;
  atReady: number;
  readySeen: boolean;
}

export function installPipelineCounter(): void {
  const counts: PipelineCounts = { total: 0, atReady: 0, readySeen: false };
  (window as Window & { __pipelineCounts?: PipelineCounts }).__pipelineCounts = counts;
  const wrap = (proto: object | undefined, names: readonly string[]): void => {
    if (proto === undefined) return;
    for (const name of names) {
      const original: unknown = Reflect.get(proto, name);
      if (typeof original !== 'function') continue;
      Reflect.set(proto, name, function (this: unknown, ...args: unknown[]): unknown {
        counts.total += 1;
        const result: unknown = Reflect.apply(original, this, args);
        return result;
      });
    }
  };
  const scope = globalThis as { WebGL2RenderingContext?: { prototype: object }; GPUDevice?: { prototype: object } };
  wrap(scope.WebGL2RenderingContext?.prototype, ['linkProgram']);
  wrap(scope.GPUDevice?.prototype, ['createRenderPipeline', 'createRenderPipelineAsync']);
  window.addEventListener('cryscade:scene-ready', () => {
    counts.atReady = counts.total;
    counts.readySeen = true;
  });
}
