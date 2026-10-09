// Монтирование рендерера под StrictMode (§10). Экземпляр живёт в рефе компонента и переживает двойной эффект.
// Монтирования идут цепочкой через промис: следующий рендерер создаётся только после того, как предыдущий
// дошёл до конца init и уничтожен. Отменённое до своей очереди монтирование рендерер не создаёт вовсе;
// размонтировались во время await init — рендерер уничтожается сразу по возврату. Живых — не больше одного.

import type { RendererInfo, RendererLifecycle } from '../render/renderer.ts';

export class SceneMount<R extends RendererLifecycle> {
  readonly #create: () => R;
  readonly #onReady: (renderer: R, info: RendererInfo) => void;
  readonly #onError: (error: unknown) => void;
  #chain: Promise<void> = Promise.resolve();
  #generation = 0;
  #attached = false;
  #live: R | null = null;

  constructor(create: () => R, onReady: (renderer: R, info: RendererInfo) => void, onError: (error: unknown) => void) {
    this.#create = create;
    this.#onReady = onReady;
    this.#onError = onError;
  }

  /** Живой рендерер: init прошёл, монтирование актуально. */
  get renderer(): R | null {
    return this.#live;
  }

  /** Цепочка отработала — для тестов и зонда. */
  get settled(): Promise<void> {
    return this.#chain;
  }

  /** Эффект смонтирован. */
  attach(host: HTMLElement): void {
    if (this.#attached) throw new Error('SceneMount: attach без detach');
    this.#attached = true;
    const generation = ++this.#generation;
    // Сбой одного звена не рвёт цепочку: следующие монтирования должны пройти.
    this.#chain = this.#chain
      .then(() => this.#start(generation, host))
      .catch((error: unknown) => {
        this.#onError(error);
      });
  }

  /** Очистка эффекта: живой рендерер уничтожается синхронно, ждущий в очереди — отменяется. */
  detach(): void {
    this.#attached = false;
    this.#generation += 1;
    const live = this.#live;
    this.#live = null;
    live?.destroy();
  }

  async #start(generation: number, host: HTMLElement): Promise<void> {
    if (generation !== this.#generation) return;
    const renderer = this.#create();
    let info: RendererInfo;
    try {
      info = await renderer.init(host);
    } catch (error) {
      // Рендерер после неудачного init уничтожается так же: он мог успеть создать канвас и контекст.
      renderer.destroy();
      if (generation === this.#generation) this.#onError(error);
      return;
    }
    if (generation !== this.#generation) {
      renderer.destroy();
      return;
    }
    this.#live = renderer;
    this.#onReady(renderer, info);
  }
}
