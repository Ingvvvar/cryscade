import type { SpinMode } from '../model/config.ts';
import type { SymbolSource } from './source.ts';

/** Раунд сделал больше запросов к источнику, чем разрешил вызывающий: надкритичная фича или бесконечный каскад. */
export class WatchdogError extends Error {
  override readonly name = 'WatchdogError';
}

/**
 * Декоратор источника символов: считает запросы раунда и после limit роняет раунд с его сидом.
 * Порог задаёт вызывающий — у движка своего нет. Срабатывание — всегда ошибка, никогда не пропуск сида:
 * пропуск молча сместил бы статистику и книгу (§4.7). Без порога (limit = ∞) только считает.
 */
export class WatchdogSource implements SymbolSource {
  readonly #inner: SymbolSource;
  readonly #limit: number;
  #seed = -1;
  #requests = 0;

  constructor(inner: SymbolSource, limit: number) {
    if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new RangeError(`порог сторожа: ожидается целое от 1 или ∞, получено ${String(limit)}`);
    }
    this.#inner = inner;
    this.#limit = limit;
  }

  /** Запросов к источнику с последнего arm. */
  get requests(): number {
    return this.#requests;
  }

  /** Новый раунд: счёт с нуля, сид — для сообщения. */
  arm(seed: number): void {
    this.#seed = seed;
    this.#requests = 0;
  }

  next(mode: SpinMode, cell: number): number {
    this.#requests += 1;
    if (this.#requests > this.#limit) {
      throw new WatchdogError(
        `сторож: раунд с сидом ${String(this.#seed)} сделал больше ${String(this.#limit)} запросов к источнику — ` +
          'фича надкритична или каскад бесконечен',
      );
    }
    return this.#inner.next(mode, cell);
  }
}
