import { EventRecorder, SeededEngine } from '../core/engine/index.ts';
import type { GameConfig } from '../core/model/config.ts';
import type { RoundEvent } from '../core/model/events.ts';

export interface PlayedRound {
  /** Итог раунда в сотых долях ставки — end.payX100. */
  readonly payX100: number;
  readonly events: readonly RoundEvent[];
}

/**
 * Раунд по сиду в записывающем режиме под сторожем сервера — одна дорога для живых раундов, восстановления событий
 * испорченной записи и сетки-заставки. Сработавший сторож — WatchdogError с сидом. Записать события, которые сервер
 * сам отвергнет при чтении, не даст проверка записи в RgsServer.
 */
export class SeededRounds {
  readonly #recorder = new EventRecorder();
  readonly #engine: SeededEngine;

  constructor(config: GameConfig, maxRequests: number) {
    this.#engine = new SeededEngine(config, this.#recorder, { maxRequests });
  }

  play(seed: number): PlayedRound {
    const payX100 = this.#engine.play(seed);
    return { payX100, events: this.#recorder.events };
  }
}
