import { RngSymbolSource, RoundEngine, type RoundRecorder, type SymbolSource } from '../../src/core/engine/index.ts';
import type { GameConfig, SpinMode } from '../../src/core/model/config.ts';
import { Xoshiro128ss } from '../../src/core/rng/index.ts';

/**
 * Порог сторожа: запросов к источнику за раунд. Самый длинный раунд на 100 000 сидах: стресс-конфиг — 2017,
 * черновик игры — 1072, TEST_CONFIG с капом — 23 909 на 200. Порог выше: срабатывает только на надкритичной фиче
 * без капа или бесконечном каскаде — и за миллисекунды, а не зависанием.
 */
export const WATCHDOG_LIMIT = 100_000;

export class WatchdogError extends Error {
  override readonly name = 'WatchdogError';
}

/** Декоратор источника символов: после limit запросов за раунд роняет раунд с его сидом. */
export class WatchdogSource implements SymbolSource {
  readonly #inner: SymbolSource;
  readonly #limit: number;
  #seed = -1;
  #requests = 0;

  constructor(inner: SymbolSource, limit: number) {
    this.#inner = inner;
    this.#limit = limit;
  }

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

/** Раунды по сиду под сторожем: тот же поток символов, что у SeededEngine (сверено в property-тесте). */
export class GuardedRounds {
  readonly #random = new Xoshiro128ss(0);
  readonly #watchdog: WatchdogSource;
  readonly #engine: RoundEngine;

  constructor(config: GameConfig, recorder: RoundRecorder, limit = WATCHDOG_LIMIT) {
    this.#watchdog = new WatchdogSource(new RngSymbolSource(config.weights, this.#random), limit);
    this.#engine = new RoundEngine(config, this.#watchdog, recorder);
  }

  /** Запросов к источнику за последний раунд. */
  get requests(): number {
    return this.#watchdog.requests;
  }

  play(seed: number): number {
    this.#random.reseed(seed);
    this.#watchdog.arm(seed);
    return this.#engine.play();
  }
}
