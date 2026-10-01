// Фазы кадра для DevTools (§13, правила замеров) — только dev: дорожка «Cryscade» в панели Performance через
// performance.measure с detail.devtools — «обновление» (часы показа и сцена, наш тик на NORMAL) и «отрисовка» (render
// Pixi на LOW). Рендерер создаёт разметку под import.meta.env.DEV: в прод- и e2e-сборке ветка выпадает вместе с классом
// (греп маркера — tests/e2e/bundle.spec.ts). Записи сразу снимаются с буфера: DevTools получает их при создании, а буфер
// за час dev-сессии иначе набрал бы сотни тысяч записей. Объекты на кадр здесь есть — это dev, не горячий путь игры.

import { UPDATE_PRIORITY, type Ticker } from 'pixi.js';

const UPDATE = 'cryscade: обновление';
const RENDER = 'cryscade: отрисовка';

function measure(name: string, start: number, end: number): void {
  performance.measure(name, { start, end, detail: { devtools: { dataType: 'track-entry', track: 'Cryscade', color: 'tertiary' } } });
  performance.clearMeasures(name);
}

export class FrameMarks {
  #updateStart = 0;
  #renderStart = 0;
  readonly #beforeUpdate = (): void => {
    this.#updateStart = performance.now();
  };
  readonly #beforeRender = (): void => {
    this.#renderStart = performance.now();
    measure(UPDATE, this.#updateStart, this.#renderStart);
  };
  readonly #afterRender = (): void => {
    measure(RENDER, this.#renderStart, performance.now());
  };

  /** Слушатели вокруг кадра: HIGH — до тика рендерера (NORMAL), LOW + 1 — между ним и render Pixi (LOW), UTILITY — после. */
  attach(ticker: Ticker): void {
    ticker.add(this.#beforeUpdate, undefined, UPDATE_PRIORITY.HIGH);
    ticker.add(this.#beforeRender, undefined, UPDATE_PRIORITY.LOW + 1);
    ticker.add(this.#afterRender, undefined, UPDATE_PRIORITY.UTILITY);
  }

  detach(ticker: Ticker): void {
    ticker.remove(this.#beforeUpdate);
    ticker.remove(this.#beforeRender);
    ticker.remove(this.#afterRender);
  }
}
