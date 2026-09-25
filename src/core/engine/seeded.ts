import type { GameConfig } from '../model/config.ts';
import { Xoshiro128ss } from '../rng/index.ts';
import { RoundEngine } from './engine.ts';
import type { RoundRecorder } from './recorder.ts';
import { RngSymbolSource } from './source.ts';
import { WatchdogSource } from './watchdog.ts';

export interface SeededEngineOptions {
  /**
   * Порог сторожа: запросов к источнику за раунд. Задаёт вызывающий по самому длинному честному раунду своего
   * конфига (§4.7); без него сторожа нет. Превышение — WatchdogError с сидом.
   */
  readonly maxRequests?: number;
}

/**
 * Раунд по сиду (§4.7): единственное место, где сид превращается в поток символов, —
 * одинаково для сервера, книги и повтора. ГСЧ пересевается на месте, без аллокаций на раунд.
 */
export class SeededEngine {
  readonly #random: Xoshiro128ss;
  readonly #watchdog: WatchdogSource;
  readonly #engine: RoundEngine;

  constructor(config: GameConfig, recorder: RoundRecorder, options: SeededEngineOptions = {}) {
    this.#random = new Xoshiro128ss(0);
    this.#watchdog = new WatchdogSource(
      new RngSymbolSource(config.weights, this.#random),
      options.maxRequests ?? Number.POSITIVE_INFINITY,
    );
    this.#engine = new RoundEngine(config, this.#watchdog, recorder);
  }

  /** Запросов к источнику за последний раунд. */
  get requests(): number {
    return this.#watchdog.requests;
  }

  /** Сид — целое от 0 до 2^32 − 1. Возвращает итог в сотых долях ставки. */
  play(seed: number): number {
    this.#random.reseed(seed);
    this.#watchdog.arm(seed);
    return this.#engine.play();
  }
}
