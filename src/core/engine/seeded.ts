import type { GameConfig } from '../model/config.ts';
import { Xoshiro128ss } from '../rng/index.ts';
import { RoundEngine } from './engine.ts';
import type { RoundRecorder } from './recorder.ts';
import { RngSymbolSource } from './source.ts';

/**
 * Раунд по сиду (§4.7): единственное место, где сид превращается в поток символов, —
 * одинаково для сервера, книги и повтора. ГСЧ пересевается на месте, без аллокаций на раунд.
 */
export class SeededEngine {
  readonly #random: Xoshiro128ss;
  readonly #engine: RoundEngine;

  constructor(config: GameConfig, recorder: RoundRecorder) {
    this.#random = new Xoshiro128ss(0);
    this.#engine = new RoundEngine(config, new RngSymbolSource(config.weights, this.#random), recorder);
  }

  /** Сид — целое от 0 до 2^32 − 1. Возвращает итог в сотых долях ставки. */
  play(seed: number): number {
    this.#random.reseed(seed);
    return this.#engine.play();
  }
}
