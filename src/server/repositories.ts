import type { KeyRange, Storage, StoreKey } from './ports.ts';
import {
  RECORD_LIMIT,
  checkKey,
  checkRound,
  checkRoundCore,
  checkWallet,
  type KeyRecord,
  type RoundCore,
  type RoundRecord,
  type WalletRecord,
} from './records.ts';
import { WALLET_ID } from './schema.ts';

// Репозитории поверх Storage: кошелёк, раунды, ключи идемпотентности. Каждый проверяет гардом то, что прочитал, и
// отвечает «цело», «нет» или «испорчено» — с сырыми данными для карантина. Пишет только сервер, одной транзакцией.

export type Read<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'absent' }
  | { readonly kind: 'damaged'; readonly raw: unknown; readonly reason: string };

/** У испорченного раунда core — его цельная часть без событий, если она цела: события можно пересчитать по сиду. */
export type RoundRead =
  | { readonly kind: 'ok'; readonly value: RoundRecord }
  | { readonly kind: 'absent' }
  | { readonly kind: 'damaged'; readonly raw: unknown; readonly reason: string; readonly core: RoundCore | null };

export interface LatestRound {
  /** Первичный ключ записи — по нему её можно снять, даже испорченную. */
  readonly key: StoreKey;
  /** Значение индекса seq — целое: диапазон индекса числовой. */
  readonly seq: number;
  readonly read: RoundRead;
}

/** seq вне границы записей — испорченная запись: для индекса её нет, как и записи с нечисловым seq. */
const SEQ_RANGE: KeyRange = { lower: 1, upper: RECORD_LIMIT };

function coreOf(round: RoundCore): RoundCore {
  return {
    roundId: round.roundId,
    seq: round.seq,
    idempotencyKey: round.idempotencyKey,
    betMinor: round.betMinor,
    seed: round.seed,
    payX100: round.payX100,
    winMinor: round.winMinor,
    createdAt: round.createdAt,
    status: round.status,
    balanceAfterBet: round.balanceAfterBet,
    balanceAfterEnd: round.balanceAfterEnd,
  };
}

function classifyRound(raw: unknown): RoundRead {
  if (raw === undefined) return { kind: 'absent' };
  const reason = checkRound(raw);
  if (reason === null) return { kind: 'ok', value: raw as RoundRecord };
  return { kind: 'damaged', raw, reason, core: checkRoundCore(raw) === null ? coreOf(raw as RoundCore) : null };
}

export class WalletRepository {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async read(): Promise<Read<WalletRecord>> {
    const raw = await this.#storage.get('wallet', WALLET_ID);
    if (raw === undefined) return { kind: 'absent' };
    const reason = checkWallet(raw);
    return reason === null ? { kind: 'ok', value: raw as WalletRecord } : { kind: 'damaged', raw, reason };
  }
}

export class RoundRepository {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async read(roundId: string): Promise<RoundRead> {
    return classifyRound(await this.#storage.get('rounds', roundId));
  }

  /** Раунды с наибольшими seq, по убыванию. */
  async latest(limit: number): Promise<LatestRound[]> {
    const found = await this.#storage.lastByIndex('rounds', 'seq', SEQ_RANGE, limit);
    return found.map(({ key, indexKey, value }) => ({ key, seq: Number(indexKey), read: classifyRound(value) }));
  }

  /** Ключи записей с seq от 1 до upper — кандидаты на вытеснение. */
  upToSeq(upper: number): Promise<StoreKey[]> {
    return upper < 1 ? Promise.resolve([]) : this.#storage.keysByIndex('rounds', 'seq', { lower: 1, upper });
  }
}

export class IdempotencyRepository {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async read(key: string): Promise<Read<KeyRecord>> {
    const raw = await this.#storage.get('keys', key);
    if (raw === undefined) return { kind: 'absent' };
    const reason = checkKey(raw);
    return reason === null ? { kind: 'ok', value: raw as KeyRecord } : { kind: 'damaged', raw, reason };
  }

  /** Ключи, записанные за раундом — по индексу, а не по содержимому записи раунда. */
  ofRound(roundId: StoreKey): Promise<StoreKey[]> {
    return this.#storage.keysByIndex('keys', 'roundId', { lower: roundId, upper: roundId });
  }
}
