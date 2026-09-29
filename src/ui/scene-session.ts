// Сессия сцены: монтирование рендерера (SceneMount) плюс последнее состояние окна и игры. Рендерер, дошедший до
// готовности, получает текущий вьюпорт, reduced motion, сетку и число выигрыша; до готовности всё копится здесь.
// Раскладку отдаёт React-панели: она ставит кнопки по тем же зонам, что Pixi — сетку.

import type { SymbolId } from '../core/model/symbols.ts';
import { computeLayout, type Layout, type Viewport } from '../render/layout.ts';
import type { GridSink, Renderer, ViewportSink, WinSink } from '../render/renderer.ts';
import { SceneMount } from './scene-mount.ts';

/** Счётчики монтирований для тестового зонда. */
export interface MountObserver {
  noteAttach(): void;
  noteDetach(): void;
  noteError(error: unknown): void;
  /** Зонд получает перемонтирование живой сцены: путь «уничтожен живой рендерер → новый init». null — хоста нет. */
  bindRemount(remount: (() => void) | null): void;
}

export interface SceneSessionOptions {
  readonly create: () => Renderer;
  readonly onLayout: (layout: Layout) => void;
  readonly onError: (error: unknown) => void;
  readonly observer: MountObserver | null;
}

export class SceneSession implements ViewportSink, GridSink, WinSink {
  readonly #options: SceneSessionOptions;
  readonly #mount: SceneMount<Renderer>;
  #viewport: { readonly viewport: Viewport; readonly pixelRatio: number } | null = null;
  #reducedMotion = false;
  /** Сетку присылает authenticate: до его ответа сетки нет. */
  #grid: readonly SymbolId[] | null = null;
  #win: string | null = null;

  constructor(options: SceneSessionOptions) {
    this.#options = options;
    this.#mount = new SceneMount<Renderer>(
      options.create,
      (renderer) => {
        this.#ready(renderer);
      },
      (error) => {
        options.observer?.noteError(error);
        options.onError(error);
      },
    );
  }

  /** Цепочка монтирований отработала — для тестов. */
  get settled(): Promise<void> {
    return this.#mount.settled;
  }

  attach(host: HTMLElement): void {
    this.#options.observer?.noteAttach();
    this.#mount.attach(host);
  }

  detach(): void {
    this.#options.observer?.noteDetach();
    this.#mount.detach();
  }

  resize(viewport: Viewport, pixelRatio: number): void {
    this.#viewport = { viewport, pixelRatio };
    this.#options.onLayout(computeLayout(viewport));
    this.#mount.renderer?.resize(viewport, pixelRatio);
  }

  setReducedMotion(on: boolean): void {
    this.#reducedMotion = on;
    this.#mount.renderer?.setReducedMotion(on);
  }

  showGrid(grid: readonly SymbolId[]): void {
    this.#grid = grid;
    this.#mount.renderer?.showGrid(grid);
  }

  showWin(text: string): void {
    this.#win = text;
    this.#mount.renderer?.showWin(text);
  }

  #ready(renderer: Renderer): void {
    if (this.#viewport !== null) renderer.resize(this.#viewport.viewport, this.#viewport.pixelRatio);
    renderer.setReducedMotion(this.#reducedMotion);
    if (this.#grid !== null) renderer.showGrid(this.#grid);
    if (this.#win !== null) renderer.showWin(this.#win);
  }
}
