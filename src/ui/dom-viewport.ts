// Источник вьюпорта из DOM: размер хоста — ResizeObserver, отступы безопасной зоны — вычисленные поля
// скрытого элемента с padding: env(safe-area-inset-*) (из JS env() напрямую не читается).

import type { Insets, Viewport } from '../render/layout.ts';
import type { ViewportSource } from './viewport-watcher.ts';

export class DomViewportSource implements ViewportSource {
  readonly #host: HTMLElement;
  readonly #insetProbe: HTMLElement;

  constructor(host: HTMLElement, insetProbe: HTMLElement) {
    this.#host = host;
    this.#insetProbe = insetProbe;
  }

  read(): Viewport {
    const rect = this.#host.getBoundingClientRect();
    return { width: rect.width, height: rect.height, insets: this.#insets() };
  }

  observe(listener: () => void): () => void {
    const observer = new ResizeObserver(() => {
      listener();
    });
    observer.observe(this.#host);
    return () => {
      observer.disconnect();
    };
  }

  #insets(): Insets {
    const style = getComputedStyle(this.#insetProbe);
    const px = (value: string): number => Number.parseFloat(value) || 0;
    return { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
  }
}
