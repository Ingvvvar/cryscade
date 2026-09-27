// Наблюдатель за окном: размер хоста и безопасная зона, reduced motion, смена DPR.
// Смену DPR при переносе окна между мониторами ResizeObserver по content-box не замечает: CSS-размер тот же.
// Её ловит matchMedia на (resolution: Ndppx) текущего DPR; после срабатывания запрос ставится заново уже на
// новый DPR — иначе следующий перенос пропущен, и кадр мылится.

import type { Viewport } from '../render/layout.ts';
import type { ViewportSink } from '../render/renderer.ts';

export interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

/** Окно в той мере, в какой оно нужно наблюдателю: в тестах — подстановка. */
export interface ScreenEnvironment {
  readonly devicePixelRatio: number;
  matchMedia(query: string): MediaQueryListLike;
}

/** Размер хоста и отступы безопасной зоны. observe возвращает отписку. */
export interface ViewportSource {
  read(): Viewport;
  observe(listener: () => void): () => void;
}

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function resolutionQuery(devicePixelRatio: number): string {
  return `(resolution: ${String(devicePixelRatio)}dppx)`;
}

export class ViewportWatcher {
  readonly #screen: ScreenEnvironment;
  readonly #source: ViewportSource;
  readonly #sink: ViewportSink;
  readonly #push = (): void => {
    this.#sink.resize(this.#source.read(), this.#screen.devicePixelRatio);
  };
  readonly #onMotion = (): void => {
    this.#sink.setReducedMotion(this.#motion?.matches ?? false);
  };
  readonly #onResolution = (): void => {
    this.#watchResolution();
    this.#push();
  };
  #motion: MediaQueryListLike | null = null;
  #resolution: MediaQueryListLike | null = null;
  #stopObserving: (() => void) | null = null;

  constructor(screen: ScreenEnvironment, source: ViewportSource, sink: ViewportSink) {
    this.#screen = screen;
    this.#source = source;
    this.#sink = sink;
  }

  /** Сразу отдаёт текущее состояние и подписывается на изменения. */
  start(): void {
    this.#motion = this.#screen.matchMedia(REDUCED_MOTION_QUERY);
    this.#motion.addEventListener('change', this.#onMotion);
    this.#watchResolution();
    this.#stopObserving = this.#source.observe(this.#push);
    this.#onMotion();
    this.#push();
  }

  dispose(): void {
    this.#motion?.removeEventListener('change', this.#onMotion);
    this.#resolution?.removeEventListener('change', this.#onResolution);
    this.#stopObserving?.();
    this.#motion = null;
    this.#resolution = null;
    this.#stopObserving = null;
  }

  #watchResolution(): void {
    this.#resolution?.removeEventListener('change', this.#onResolution);
    this.#resolution = this.#screen.matchMedia(resolutionQuery(this.#screen.devicePixelRatio));
    this.#resolution.addEventListener('change', this.#onResolution);
  }
}
