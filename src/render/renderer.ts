// Фасад рендера для ui/ (§3): интерфейсы маленькие, под потребителя. Через них идут простые данные.
// Реализация — PixiRenderer в render/pixi/; ui/ знает только эти интерфейсы, кроме корня композиции.

import type { SymbolId } from '../core/model/symbols.ts';
import type { Viewport } from './layout.ts';

export type RendererName = 'webgpu' | 'webgl';

/** Фактический рендерер: имя и строка GPU — ими подписываются замеры и снимки. */
export interface RendererInfo {
  readonly name: RendererName;
  readonly gpu: string;
  /** Программный рендер (SwiftShader, запасной адаптер WebGPU): на нём производительность не мерят. */
  readonly software: boolean;
}

/** Жизненный цикл — для SceneMount. init асинхронный; канвас рендерер создаёт в host сам и сам убирает в destroy. */
export interface RendererLifecycle {
  init(host: HTMLElement): Promise<RendererInfo>;
  destroy(): void;
}

/** Вьюпорт и reduced motion — для наблюдателя за окном. pixelRatio — devicePixelRatio экрана как есть. */
export interface ViewportSink {
  resize(viewport: Viewport, pixelRatio: number): void;
  setReducedMotion(on: boolean): void;
}

/** Сетка раунда: 49 символов по клеткам, cell = row * 7 + col. */
export interface GridSink {
  showGrid(grid: readonly SymbolId[]): void;
}

export interface Renderer extends RendererLifecycle, ViewportSink, GridSink {}
