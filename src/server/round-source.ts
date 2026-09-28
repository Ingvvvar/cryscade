import type { RoundEvent } from '../core/model/events.ts';
import type { Entropy } from './ports.ts';
import type { SeededRounds } from './seeded-rounds.ts';

export interface RoundDraw {
  readonly seed: number;
  readonly payX100: number;
  readonly events: readonly RoundEvent[];
}

/**
 * Источник раундов (Strategy, §3). Сейчас — живой ГСЧ; в фазе 6 придёт книга исходов: сид выбирается по весам
 * записи, события — тем же движком. Там выбор станет асинхронным (HMAC через crypto.subtle) — интерфейс вырастет тогда.
 */
export interface RoundSource {
  draw(): RoundDraw;
}

/** Живой источник: криптостойкий сид из порта Entropy → движок. */
export class LiveRoundSource implements RoundSource {
  readonly #entropy: Entropy;
  readonly #rounds: SeededRounds;

  constructor(entropy: Entropy, rounds: SeededRounds) {
    this.#entropy = entropy;
    this.#rounds = rounds;
  }

  draw(): RoundDraw {
    const seed = this.#entropy.seed();
    return { seed, ...this.#rounds.play(seed) };
  }
}
