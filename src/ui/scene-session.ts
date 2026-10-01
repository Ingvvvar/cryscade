// Сессия сцены: монтирование рендерера (SceneMount) плюс последнее состояние окна, источник кадра и язык. Рендерер,
// дошедший до готовности, получает текущий вьюпорт, reduced motion, источник кадра — часы показа, из которых он сам тянет
// кадры, — и язык игрока.
// Раскладку отдаёт React-панели: она ставит кнопки по тем же зонам, что Pixi — сетку.

import { computeLayout, type Layout, type Viewport } from '../render/layout.ts';
import type { NumberStyle } from '../render/number-layout.ts';
import type { LanguageSink, Renderer, SceneSource, SceneTexts, SourceSink, ViewportSink } from '../render/renderer.ts';
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
  /** Рендерер дошёл до готовности — его первый кадр на следующем тике. */
  readonly onReady?: () => void;
  readonly onLayout: (layout: Layout) => void;
  readonly onError: (error: unknown) => void;
  readonly observer: MountObserver | null;
}

export class SceneSession implements ViewportSink, SourceSink, LanguageSink {
  readonly #options: SceneSessionOptions;
  readonly #mount: SceneMount<Renderer>;
  #viewport: { readonly viewport: Viewport; readonly pixelRatio: number } | null = null;
  #reducedMotion = false;
  #source: SceneSource | null = null;
  #language: { readonly texts: SceneTexts; readonly numbers: NumberStyle } | null = null;

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

  setSource(source: SceneSource | null): void {
    this.#source = source;
    this.#mount.renderer?.setSource(source);
  }

  setLanguage(texts: SceneTexts, numbers: NumberStyle): void {
    this.#language = { texts, numbers };
    this.#mount.renderer?.setLanguage(texts, numbers);
  }

  #ready(renderer: Renderer): void {
    if (this.#viewport !== null) renderer.resize(this.#viewport.viewport, this.#viewport.pixelRatio);
    renderer.setReducedMotion(this.#reducedMotion);
    renderer.setSource(this.#source);
    if (this.#language !== null) renderer.setLanguage(this.#language.texts, this.#language.numbers);
    this.#options.onReady?.();
  }
}
