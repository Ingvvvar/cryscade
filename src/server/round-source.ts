import type { RoundEvent } from '../core/model/events.ts';
import type { Book } from './book.ts';
import { drawIndex, fromHex } from './fairness.ts';
import type { Crypto, Entropy } from './ports.ts';
import type { RoundFairness } from './records.ts';
import type { SeededRounds } from './seeded-rounds.ts';

export interface RoundDraw {
  readonly seed: number;
  readonly payX100: number;
  readonly events: readonly RoundEvent[];
  /** Откуда раунд и его поля честности — как их запишет сервер. */
  readonly fairness: RoundFairness;
}

/** Честность на момент play: секрет (hex), его обязательство, сид игрока и nonce этого раунда. */
export interface FairnessContext {
  readonly secret: string;
  readonly commitment: string;
  readonly clientSeed: string;
  readonly nonce: number;
}

const NO_FAIRNESS = { bookIndex: null, nonce: null, commitment: null, clientSeed: null } as const;

/**
 * Источник раундов (Strategy, §3): книга исходов (§5, §7) или живой ГСЧ. Книге нужен контекст честности — без него
 * она не выбирает; живому и принудительному он не нужен.
 */
export interface RoundSource {
  draw(fairness: FairnessContext | null): Promise<RoundDraw>;
}

/** Книга: HMAC(секрет, сид игрока:nonce:counter) → запись → движок по её сиду; итог обязан совпасть с записью. */
export class BookRoundSource implements RoundSource {
  readonly #book: () => Book;
  readonly #crypto: Crypto;
  readonly #rounds: SeededRounds;

  /** book — уже загруженная книга: сервер дожидается её до замка кошелька. */
  constructor(book: () => Book, hashing: Crypto, rounds: SeededRounds) {
    this.#book = book;
    this.#crypto = hashing;
    this.#rounds = rounds;
  }

  async draw(fairness: FairnessContext | null): Promise<RoundDraw> {
    if (fairness === null) throw new Error('книга: нет состояния честности');
    const book = this.#book();
    const { index } = await drawIndex((key, message) => this.#crypto.hmacSha256(key, message), fromHex(fairness.secret), fairness.clientSeed, fairness.nonce, book);
    const record = book.record(index);
    const played = this.#rounds.play(record.seed);
    if (played.payX100 !== record.payX100) {
      throw new Error(`книга и движок разошлись: запись ${String(index)}, сид ${String(record.seed)} — ${String(played.payX100)}, в книге ${String(record.payX100)}`);
    }
    return {
      seed: record.seed,
      ...played,
      fairness: { source: 'book', bookIndex: index, nonce: fairness.nonce, commitment: fairness.commitment, clientSeed: fairness.clientSeed },
    };
  }
}

/** Живой источник — только тесты и раунды до фазы 6: криптостойкий сид из порта Entropy → движок, без честности. */
export class LiveRoundSource implements RoundSource {
  readonly #entropy: Entropy;
  readonly #rounds: SeededRounds;

  constructor(entropy: Entropy, rounds: SeededRounds) {
    this.#entropy = entropy;
    this.#rounds = rounds;
  }

  draw(): Promise<RoundDraw> {
    const seed = this.#entropy.seed();
    return Promise.resolve({ seed, ...this.#rounds.play(seed), fairness: { source: 'live', ...NO_FAIRNESS } });
  }
}

export const FORCED_FAIRNESS: RoundFairness = { source: 'forced', ...NO_FAIRNESS };
