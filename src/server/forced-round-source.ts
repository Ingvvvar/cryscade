import { FORCED_FAIRNESS, type FairnessContext, type RoundDraw, type RoundSource } from './round-source.ts';
import type { SeededRounds } from './seeded-rounds.ts';

// Принудительный раунд (dev и e2e, фаза 5): Strategy-декоратор над источником раундов. Сид следующего раунда задаёт
// зонд мимо протокола; деньги идут обычным путём — play, списание, endRound, зачисление. Раунд помечен forced: nonce не
// тратит и в проверке честности не участвует (фаза 6). Корень композиции воркера подключает его только в dev и
// e2e-сборке: в проде этого кода нет (греп маркера — tests/e2e/bundle.spec.ts).

export class ForcedRoundSource implements RoundSource {
  readonly #inner: RoundSource;
  readonly #rounds: SeededRounds;
  #next: number | null = null;

  constructor(inner: RoundSource, rounds: SeededRounds) {
    this.#inner = inner;
    this.#rounds = rounds;
  }

  /** Сид следующего раунда; за ним — снова живой источник. */
  force(seed: number): void {
    this.#next = seed;
  }

  draw(fairness: FairnessContext | null): Promise<RoundDraw> {
    const seed = this.#next;
    if (seed === null) return this.#inner.draw(fairness);
    this.#next = null;
    return Promise.resolve({ seed, ...this.#rounds.play(seed), fairness: FORCED_FAIRNESS });
  }
}
