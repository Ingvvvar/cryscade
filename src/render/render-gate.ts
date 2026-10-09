// Когда рисовать кадр (§10): по требованию — эконом-режим без GPU рисует, только когда кадр изменился (показ, ввод,
// ресайз, смена состояния), — и не чаще порога по времени тикера (зонд e2e при программном рендере, §14). Без того и
// другого — каждый кадр, как TickerPlugin Pixi. Отложенное порогом не теряется: изменённый кадр нарисуется, как только
// порог выйдет. Тикер, часы показа и сцена идут каждый кадр — решается только отрисовка.

export class RenderGate {
  readonly #onDemand: boolean;
  #minIntervalMs = 0;
  /** Кадр изменился с последней отрисовки; первая — сразу. */
  #dirty = true;
  /** Время тикера с последней отрисовки, мс; первая — сразу. */
  #sinceMs = Number.POSITIVE_INFINITY;

  constructor(onDemand: boolean) {
    this.#onDemand = onDemand;
  }

  /** Кадр изменился — нарисовать при первой возможности. */
  invalidate(): void {
    this.#dirty = true;
  }

  /** Не чаще раза в ms по времени тикера; 0 — без порога. */
  throttle(ms: number): void {
    if (!(Number.isFinite(ms) && ms >= 0)) throw new RangeError(`порог отрисовки — неотрицательное число мс: ${String(ms)}`);
    this.#minIntervalMs = ms;
  }

  /** Прошёл кадр тикера длиной elapsedMs: рисовать ли его. */
  frame(elapsedMs: number): boolean {
    this.#sinceMs += elapsedMs;
    if (this.#onDemand && !this.#dirty) return false;
    if (this.#sinceMs < this.#minIntervalMs) return false;
    this.#sinceMs = 0;
    this.#dirty = false;
    return true;
  }
}
