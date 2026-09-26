// Время декора: фон-шейдер и блик рамки. Не время раунда — его ведёт презентация.
// Три режима по старшинству: закреплено (тесты и снимки) → стоит (reduced motion, §8.4) → течёт от тикера.
// Время заворачивается: во float32 шейдера большие значения теряют точность и анимация дрожит.

/** Период заворота, с. Шаг float32 у верхней границы — полмиллисекунды. */
export const AMBIENT_PERIOD_S = 4096;
/** Момент, на котором декор стоит при reduced motion. */
export const AMBIENT_STILL_S = 12.5;

export class AmbientClock {
  #runningMs = 0;
  #pinned: number | null = null;
  #reducedMotion = false;

  /** Шаг тикера. Пока декор стоит, собственное время не идёт — после снятия продолжится с того же места. */
  advance(deltaMs: number): void {
    if (this.#reducedMotion || !(deltaMs > 0)) return;
    this.#runningMs = (this.#runningMs + deltaMs) % (AMBIENT_PERIOD_S * 1000);
  }

  get seconds(): number {
    if (this.#pinned !== null) return this.#pinned;
    if (this.#reducedMotion) return AMBIENT_STILL_S;
    return this.#runningMs / 1000;
  }

  /** null снимает закрепление. */
  pin(seconds: number | null): void {
    if (seconds !== null && !Number.isFinite(seconds)) throw new RangeError(`время декора — конечное число: ${String(seconds)}`);
    this.#pinned = seconds;
  }

  setReducedMotion(on: boolean): void {
    this.#reducedMotion = on;
  }
}
