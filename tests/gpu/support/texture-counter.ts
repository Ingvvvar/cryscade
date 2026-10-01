// Счётчик текстур GPU — init-скрипт теста, а не код игры: считает на границе API, как счётчик draw-call. WebGL —
// createTexture, загрузки texImage2D, texSubImage2D, texStorage2D, мипмапы generateMipmap и удаление deleteTexture;
// WebGPU — createTexture, загрузки copyExternalImageToTexture и writeTexture и удаление GPUTexture.destroy (мипмапы
// WebGPU — проходы с draw, их видит счётчик draw-call). Живые текстуры — созданные минус удалённые (замер памяти §13).
// managedTextures Pixi здесь не годится: в 8.21 он помечен устаревшим с 8.15. Функцию сериализует Playwright —
// внешних ссылок в ней нет.

export interface TextureCounts {
  created: number;
  uploaded: number;
  mipmaps: number;
  destroyed: number;
}

export function installTextureCounter(): void {
  const counts: TextureCounts = { created: 0, uploaded: 0, mipmaps: 0, destroyed: 0 };
  (window as Window & { __textureCounts?: TextureCounts }).__textureCounts = counts;
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
  const scope = globalThis as {
    WebGL2RenderingContext?: { prototype: object };
    GPUDevice?: { prototype: object };
    GPUQueue?: { prototype: object };
    GPUTexture?: { prototype: object };
  };
  wrap(scope.WebGL2RenderingContext?.prototype, ['createTexture'], () => (counts.created += 1));
  wrap(scope.WebGL2RenderingContext?.prototype, ['texImage2D', 'texSubImage2D', 'texStorage2D'], () => (counts.uploaded += 1));
  wrap(scope.WebGL2RenderingContext?.prototype, ['generateMipmap'], () => (counts.mipmaps += 1));
  wrap(scope.WebGL2RenderingContext?.prototype, ['deleteTexture'], () => (counts.destroyed += 1));
  wrap(scope.GPUDevice?.prototype, ['createTexture'], () => (counts.created += 1));
  wrap(scope.GPUQueue?.prototype, ['copyExternalImageToTexture', 'writeTexture'], () => (counts.uploaded += 1));
  wrap(scope.GPUTexture?.prototype, ['destroy'], () => (counts.destroyed += 1));
}
