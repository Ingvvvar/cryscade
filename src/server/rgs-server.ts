import { WatchdogError } from '../core/engine/index.ts';
import type { GameConfig } from '../core/model/config.ts';
import { BET_LEVELS_MINOR, START_BALANCE_MINOR, isBetLevel, winMinor } from '../core/money.ts';
import { finalGrid } from '../core/presentation/final-grid.ts';
import {
  PROTOCOL_VERSION,
  isIntIn,
  isRecord,
  parseRequest,
  responseEnvelope,
  type AuthenticateResult,
  type BalanceResult,
  type FairnessView,
  type HistoryEntry,
  type HistoryResult,
  type LoadBookResult,
  type PlayResult,
  type ProtocolError,
  type ReplayResult,
  type RequestBody,
  type ResponseBody,
  type ResponseEnvelope,
  type RoundView,
  type SeedResult,
  type WalletView,
} from '../protocol/index.ts';
import type { Book } from './book.ts';
import { fromHex, toHex } from './fairness.ts';
import { COMMIT_ATTEMPTS, DEMO_SEED, HISTORY_LIMIT, SERVER_MAX_REQUESTS } from './limits.ts';
import type { BookLoader, Broadcast, Clock, Crypto, Entropy, Lock, Storage, StoreKey, StoreName, WriteOp } from './ports.ts';
import {
  RECORD_LIMIT,
  RESUME_LIMIT,
  checkFairness,
  checkKey,
  checkRound,
  checkSecret,
  checkWallet,
  fairnessOf,
  isWallet,
  type FairnessRecord,
  type KeyRecord,
  type QuarantineRecord,
  type RoundCore,
  type RoundRecord,
  type SecretRecord,
  type WalletRecord,
} from './records.ts';
import {
  FairnessRepository,
  IdempotencyRepository,
  RoundRepository,
  SecretRepository,
  WalletRepository,
  type LatestRound,
  type Read,
  type RoundRead,
  type SeqScan,
  type StrayRound,
} from './repositories.ts';
import { BookRoundSource, LiveRoundSource, type FairnessContext, type RoundSource } from './round-source.ts';
import { FAIRNESS_ID, WALLET_ID } from './schema.ts';
import { SeededRounds } from './seeded-rounds.ts';

/** Все изменения кошелька — под этим замком (§6.3): у всех вкладок один писатель. */
export const WALLET_LOCK = 'cryscade-wallet';

export interface RgsServerPorts {
  readonly storage: Storage;
  readonly lock: Lock;
  readonly clock: Clock;
  readonly entropy: Entropy;
  readonly broadcast: Broadcast;
  readonly crypto: Crypto;
}

/**
 * Источник раундов сервера. Книга (§5, §7) — в игре: раунд выбирается по HMAC, у кошелька есть честность. Живой ГСЧ —
 * только тесты сервера и клиента: без честности (fairness в authenticate — null, смена сида — BAD_REQUEST).
 * Умолчания нет: корень композиции называет источник сам.
 */
export type RoundsOption = { readonly kind: 'book'; readonly loader: BookLoader } | { readonly kind: 'live' };

export interface RgsServerOptions {
  readonly config: GameConfig;
  readonly rounds: RoundsOption;
  /** Порог сторожа; по умолчанию SERVER_MAX_REQUESTS. */
  readonly maxRequests?: number;
  /** Декоратор источника раундов (Strategy, §3): принудительный раунд dev и e2e. По умолчанию — источник как есть. */
  readonly decorateSource?: (inner: RoundSource, rounds: SeededRounds) => RoundSource;
}

/** Честность под замком: запись и её текущий секрет — цел, не раскрыт, и его SHA-256 — это обязательство. */
interface Fairness {
  readonly record: FairnessRecord;
  readonly secret: SecretRecord;
}

/** Кошелёк под замком: прошёл гард или починен, активный раунд цел и сходится с кошельком. */
interface LoadedWallet {
  readonly wallet: WalletRecord;
  /** Кошелёк лежит в хранилище. Нет — первый запуск, и условие записи — пустое место. */
  readonly stored: boolean;
  readonly active: RoundRecord | null;
  /** В этом вызове хранилище чинилось: баланс восстановлен до 1000. */
  readonly repaired: boolean;
}

/** Состояние под замком: кошелёк и, у книги, честность; null — источник без честности. */
interface Loaded extends LoadedWallet {
  readonly fairness: Fairness | null;
}

/** Кошелёк изменился между чтением и записью: транзакция отменена, операция начинается заново. */
class WriteConflict extends Error {
  override readonly name = 'WriteConflict';
}

function ok<T>(result: T): ResponseBody<T> {
  return { ok: true, result };
}

function fail(error: ProtocolError): ResponseBody<never> {
  return { ok: false, error };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function viewOf(round: RoundRecord): RoundView {
  const { source, bookIndex, nonce } = fairnessOf(round);
  return { roundId: round.roundId, betMinor: round.betMinor, payX100: round.payX100, winMinor: round.winMinor, events: round.events, source, bookIndex, nonce };
}

function fairnessView(fairness: Fairness): FairnessView {
  const { commitment, clientSeed, nonce } = fairness.record;
  return { commitment, clientSeed, nonce };
}

/** Кошелёк в ответе — прочитанный под замком или только что записанный: по revision клиент упорядочивает ответы с оповещениями. */
function walletView(wallet: WalletRecord, repaired: boolean): WalletView {
  return { balanceMinor: wallet.balanceMinor, revision: wallet.revision, notice: repaired ? 'reset' : null };
}

/** Испорченная запись — в карантин (§6.6): сырые данные и причина, чтобы разобраться потом. */
function quarantined(store: StoreName, raw: unknown, reason: string, at: number): WriteOp {
  return { op: 'add', store: 'quarantine', value: { store, raw, reason, at } satisfies QuarantineRecord };
}

function freshWallet(): WalletRecord {
  return { id: WALLET_ID, balanceMinor: START_BALANCE_MINOR, activeRoundId: null, nextSeq: 1, revision: 0, resetSeq: 1 };
}

/** Условие CAS: кошелёк в хранилище тот же, что прочитан под замком. */
function unchanged(state: LoadedWallet): (stored: unknown) => boolean {
  if (!state.stored) return (stored) => stored === undefined;
  const { revision } = state.wallet;
  return (stored) => isWallet(stored) && stored.revision === revision;
}

/** Ревизия, с которой починка продолжает счёт: прежняя, если она целая и не выше RESUME_LIMIT, иначе — с начала. */
function revisionOf(read: Read<WalletRecord>): number {
  const revision = read.kind === 'ok' ? read.value.revision : read.kind === 'damaged' && isRecord(read.raw) ? read.raw['revision'] : 0;
  return isIntIn(revision, 0, RESUME_LIMIT) ? revision : 0;
}

const NO_ROOM = 'кошельку не хватает запаса до границы записей';

/** Своя запись под тем же гардом, что при чтении; null — годится. Карантин хранит сырое как есть. */
function ownProblem(op: WriteOp): string | null {
  if (op.op === 'delete') return null;
  switch (op.store) {
    case 'wallet':
      return checkWallet(op.value);
    case 'rounds':
      return checkRound(op.value);
    case 'keys':
      return checkKey(op.value);
    case 'fairness':
      return checkFairness(op.value);
    case 'secrets':
      return checkSecret(op.value);
    case 'quarantine':
      return null;
  }
}

/** Ставка повтора записи книги: запись ставки не знает — 1.00, выигрыш = payX100 (§6.1). */
const REPLAY_BET_MINOR = 100;

/**
 * RGS (§6): кошелёк, раунды, идемпотентность — на портах. Каждый запрос — под замком кошелька; порядок в play:
 * кошелёк с починкой → ключ → активный раунд и средства → энтропия и движок → winMinor → одна транзакция с CAS по
 * revision → оповещение → ответ. Починка — раньше ключа: она снимает раунд вместе с ключами, и повтор не должен
 * получить раунд, которого уже нет. Сначала запись, потом ответ: потерянный ответ не теряет раунд.
 */
export class RgsServer {
  readonly #storage: Storage;
  readonly #lock: Lock;
  readonly #clock: Clock;
  readonly #entropy: Entropy;
  readonly #broadcast: Broadcast;
  readonly #crypto: Crypto;
  readonly #config: GameConfig;
  readonly #wallets: WalletRepository;
  readonly #rounds: RoundRepository;
  readonly #keys: IdempotencyRepository;
  readonly #fairness: FairnessRepository;
  readonly #secrets: SecretRepository;
  readonly #seeded: SeededRounds;
  readonly #source: RoundSource;
  /** Загрузчик книги; null — живой источник без честности. */
  readonly #bookLoader: BookLoader | null;
  /** Загрузка в пути; сбой её сбрасывает — следующий запрос грузит заново. */
  #bookLoading: Promise<Book> | null = null;
  #book: Book | null = null;
  /** Наибольший выигрыш одного спина — наибольшая ставка на кап: запас баланса до границы записей. */
  readonly #maxWin: number;

  constructor(ports: RgsServerPorts, options: RgsServerOptions) {
    this.#storage = ports.storage;
    this.#lock = ports.lock;
    this.#clock = ports.clock;
    this.#entropy = ports.entropy;
    this.#broadcast = ports.broadcast;
    this.#crypto = ports.crypto;
    this.#config = options.config;
    this.#wallets = new WalletRepository(ports.storage);
    this.#rounds = new RoundRepository(ports.storage);
    this.#keys = new IdempotencyRepository(ports.storage);
    this.#fairness = new FairnessRepository(ports.storage);
    this.#secrets = new SecretRepository(ports.storage);
    this.#seeded = new SeededRounds(options.config, options.maxRequests ?? SERVER_MAX_REQUESTS);
    this.#bookLoader = options.rounds.kind === 'book' ? options.rounds.loader : null;
    const inner: RoundSource =
      options.rounds.kind === 'book' ? new BookRoundSource(() => this.#loadedBook(), ports.crypto, this.#seeded) : new LiveRoundSource(ports.entropy, this.#seeded);
    this.#source = options.decorateSource?.(inner, this.#seeded) ?? inner;
    this.#maxWin = this.#price(Math.max(...BET_LEVELS_MINOR), options.config.capX100);
  }

  /** Запрос → ответ. Не бросает: любой сбой — INTERNAL, а транзакция либо записана целиком, либо не записана. */
  async handle(raw: unknown): Promise<ResponseEnvelope> {
    const request = parseRequest(raw);
    if (!request.ok) return responseEnvelope(request.id, fail(request.error));
    const { id, body } = request;
    if (body.type === 'play' && !isBetLevel(body.betMinor)) return responseEnvelope(id, fail({ code: 'INVALID_BET', betMinor: body.betMinor }));
    // Книга — до замка кошелька (§5, фаза 6): замок не держится, пока она качается. Не загрузилась — INTERNAL,
    // следующий запрос грузит заново.
    if (this.#bookLoader !== null && (body.type === 'play' || body.type === 'loadBook' || (body.type === 'replay' && 'book' in body))) {
      const problem = await this.#ensureBook(this.#bookLoader);
      if (problem !== null) return responseEnvelope(id, fail({ code: 'INTERNAL', message: problem }));
    }
    let response: ResponseBody;
    try {
      response = await this.#lock.withLock(WALLET_LOCK, () => this.#serve(body));
    } catch (error) {
      response = fail({ code: 'INTERNAL', message: messageOf(error) });
    }
    return responseEnvelope(id, response);
  }

  async #serve(body: RequestBody): Promise<ResponseBody> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#dispatch(body);
      } catch (error) {
        if (!(error instanceof WriteConflict) || attempt >= COMMIT_ATTEMPTS) throw error;
      }
    }
  }

  #dispatch(body: RequestBody): Promise<ResponseBody> {
    switch (body.type) {
      case 'authenticate':
        return this.#authenticate();
      case 'play':
        return this.#play(body.betMinor, body.idempotencyKey);
      case 'endRound':
        return this.#endRound(body.roundId);
      case 'resetBalance':
        return this.#resetBalance();
      case 'setClientSeed':
        return this.#changeSeed(body.clientSeed);
      case 'rotateSeed':
        return this.#changeSeed(null);
      case 'history':
        return this.#history(body.limit);
      case 'replay':
        return 'round' in body ? this.#replayRound(body.round) : this.#replayBook(body.book);
      case 'loadBook':
        return Promise.resolve(this.#bookSize());
    }
  }

  /** Книга загружена и сверена; null — готово, иначе понятный текст ошибки. Один запрос на всех ждущих. */
  async #ensureBook(loader: BookLoader): Promise<string | null> {
    if (this.#book !== null) return null;
    this.#bookLoading ??= loader.load();
    try {
      this.#book = await this.#bookLoading;
      return null;
    } catch (error) {
      this.#bookLoading = null;
      return `книга исходов не загрузилась: ${messageOf(error)}`;
    }
  }

  #loadedBook(): Book {
    if (this.#book === null) throw new Error('книга исходов не загружена');
    return this.#book;
  }

  #bookSize(): ResponseBody<LoadBookResult> {
    if (this.#bookLoader === null) return fail({ code: 'BAD_REQUEST', message: 'книги нет: источник раундов — живой' });
    return ok({ records: this.#loadedBook().size });
  }

  async #authenticate(): Promise<ResponseBody<AuthenticateResult>> {
    const state = await this.#load();
    return ok({
      balanceMinor: state.wallet.balanceMinor,
      config: { betLevelsMinor: [...BET_LEVELS_MINOR], capX100: this.#config.capX100 },
      activeRound: state.active === null ? null : viewOf(state.active),
      idleGrid: await this.#idleGrid(),
      notice: !this.#storage.durable ? 'volatile' : state.repaired ? 'reset' : null,
      wallet: walletView(state.wallet, state.repaired),
      fairness: state.fairness === null ? null : fairnessView(state.fairness),
    });
  }

  async #play(betMinor: number, key: string): Promise<ResponseBody<PlayResult>> {
    const state = await this.#load();
    // Сначала ключ: повтор play, чей ответ потерялся, получает свой раунд, а не ROUND_ACTIVE.
    const known = await this.#keys.read(key);
    if (known.kind === 'ok') return this.#replay(known.value, betMinor, state);
    const owner = known.kind === 'damaged' ? await this.#ownerOf(key) : null;
    if (owner !== null) return this.#replay(owner, betMinor, state);
    if (state.active !== null) return fail({ code: 'ROUND_ACTIVE', roundId: state.active.roundId });
    const { wallet } = state;
    if (wallet.balanceMinor < betMinor) return fail({ code: 'INSUFFICIENT_FUNDS', balanceMinor: wallet.balanceMinor });

    // Энтропия, HMAC и движок — до транзакции: сработавший сторож не оставляет ни одной записи, а транзакция IndexedDB
    // не ждёт криптографию.
    const fairness = state.fairness;
    const context: FairnessContext | null =
      fairness === null ? null : { secret: fairness.secret.secret, commitment: fairness.record.commitment, clientSeed: fairness.record.clientSeed, nonce: fairness.record.nonce };
    const draw = await this.#source.draw(context);
    const seq = wallet.nextSeq;
    const at = this.#clock.now();
    const round: RoundRecord = {
      roundId: this.#entropy.roundId(),
      seq,
      idempotencyKey: key,
      betMinor,
      seed: draw.seed,
      payX100: draw.payX100,
      winMinor: this.#price(betMinor, draw.payX100),
      events: draw.events,
      createdAt: at,
      status: 'active',
      balanceAfterBet: wallet.balanceMinor - betMinor,
      balanceAfterEnd: null,
      // Живой раунд пишется формой v1 — без полей честности: такой раунд гард и история читают как live.
      ...(draw.fairness.source === 'live' ? {} : draw.fairness),
    };
    const keyRecord: KeyRecord = { key, roundId: round.roundId, betMinor };
    // nonce растёт ровно на один за раунд книги — в той же транзакции, что списание и запись раунда (§7).
    const nonceOps: WriteOp[] =
      draw.fairness.source === 'book' && fairness !== null ? [{ op: 'put', store: 'fairness', value: { ...fairness.record, nonce: fairness.record.nonce + 1 } }] : [];
    // Испорченная запись ключа без своего раунда ничего не защищает: уходит в карантин, на её место — новая.
    const keyOps: WriteOp[] =
      known.kind === 'damaged'
        ? [quarantined('keys', known.raw, known.reason, at), { op: 'put', store: 'keys', value: keyRecord }]
        : [{ op: 'add', store: 'keys', value: keyRecord }];
    // Хранятся последние HISTORY_LIMIT раундов вместе с новым; старшие уходят со своими ключами.
    const evicted = await this.#rounds.upToSeq(seq - HISTORY_LIMIT);
    const evictedKeys = (await Promise.all(evicted.map((roundId) => this.#keys.ofRound(roundId)))).flat();
    const next: WalletRecord = {
      ...wallet,
      balanceMinor: round.balanceAfterBet,
      activeRoundId: round.roundId,
      nextSeq: seq + 1,
      revision: wallet.revision + 1,
    };
    await this.#commit(
      unchanged(state),
      next,
      [
        { op: 'add', store: 'rounds', value: round },
        ...keyOps,
        ...nonceOps,
        ...evicted.map((roundId): WriteOp => ({ op: 'delete', store: 'rounds', key: roundId })),
        ...evictedKeys.map((stale): WriteOp => ({ op: 'delete', store: 'keys', key: stale })),
      ],
    );
    return ok({ round: viewOf(round), balanceMinor: round.balanceAfterBet, wallet: walletView(next, state.repaired) });
  }

  /**
   * Повтор play с известным ключом: сохранённый раунд и баланс после его ставки, без нового списания. Кошелёк в ответе —
   * сегодняшний: раунд мог закрыться, и баланс после его ставки — уже прошлое.
   */
  async #replay(known: KeyRecord, betMinor: number, state: Loaded): Promise<ResponseBody<PlayResult>> {
    if (known.betMinor !== betMinor) return fail({ code: 'IDEMPOTENCY_CONFLICT' });
    const round = this.#usable(await this.#rounds.read(known.roundId));
    if (round?.idempotencyKey !== known.key) return fail({ code: 'ROUND_NOT_FOUND', roundId: known.roundId });
    return ok({ round: viewOf(round), balanceMinor: round.balanceAfterBet, wallet: walletView(state.wallet, state.repaired) });
  }

  /** Запись ключа испорчена, но ключ хранит и сам раунд: раунд с этим ключом ищется среди хранимых. */
  async #ownerOf(key: string): Promise<KeyRecord | null> {
    for (const { read } of await this.#rounds.latest(HISTORY_LIMIT)) {
      const core = read.kind === 'ok' ? read.value : read.kind === 'damaged' ? read.core : null;
      if (core?.idempotencyKey === key) return { key, roundId: core.roundId, betMinor: core.betMinor };
    }
    return null;
  }

  async #endRound(roundId: string): Promise<ResponseBody<BalanceResult>> {
    const state = await this.#load();
    const { wallet, active } = state;
    if (active?.roundId === roundId) {
      const balanceAfterEnd = wallet.balanceMinor + active.winMinor;
      const closed: RoundRecord = { ...active, status: 'closed', balanceAfterEnd };
      const next: WalletRecord = { ...wallet, balanceMinor: balanceAfterEnd, activeRoundId: null, revision: wallet.revision + 1 };
      await this.#commit(unchanged(state), next, [{ op: 'put', store: 'rounds', value: closed }]);
      return ok({ balanceMinor: balanceAfterEnd, wallet: walletView(next, state.repaired) });
    }
    // Повтор: раунд уже закрыт — тот же баланс после зачисления, без второго зачисления; кошелёк — сегодняшний.
    // Для ответа хватает цельной части записи.
    const read = await this.#rounds.read(roundId);
    const core = read.kind === 'ok' ? read.value : read.kind === 'damaged' ? read.core : null;
    if (core?.status === 'closed' && core.balanceAfterEnd !== null) {
      return ok({ balanceMinor: core.balanceAfterEnd, wallet: walletView(wallet, state.repaired) });
    }
    return fail({ code: 'ROUND_NOT_FOUND', roundId });
  }

  /**
   * Смена сида игрока (clientSeed) или только секрета (null): прежний секрет раскрыт, новое обязательство, nonce с нуля
   * (§7). Активный раунд — ROUND_ACTIVE: его nonce уже записан под прежним секретом. Запись — как любая: ревизия
   * кошелька + 1, CAS по ней.
   */
  async #changeSeed(clientSeed: string | null): Promise<ResponseBody<SeedResult>> {
    const state = await this.#load();
    const { fairness, active, wallet } = state;
    if (fairness === null) return fail({ code: 'BAD_REQUEST', message: 'честности нет: источник раундов — живой' });
    if (active !== null) return fail({ code: 'ROUND_ACTIVE', roundId: active.roundId });
    const at = this.#clock.now();
    const fresh = await this.#newSecret(at);
    const record: FairnessRecord = { id: FAIRNESS_ID, commitment: fresh.commitment, clientSeed: clientSeed ?? fairness.record.clientSeed, nonce: 0 };
    const next: WalletRecord = { ...wallet, revision: wallet.revision + 1 };
    await this.#commit(unchanged(state), next, [
      { op: 'put', store: 'secrets', value: { ...fairness.secret, revealedAt: at } satisfies SecretRecord },
      { op: 'add', store: 'secrets', value: fresh },
      { op: 'put', store: 'fairness', value: record },
    ]);
    return ok({ fairness: fairnessView({ record, secret: fresh }), revealed: { commitment: fairness.secret.commitment, secret: fairness.secret.secret } });
  }

  /** Последние раунды, новые первыми: деньги, происхождение, раскрытый секрет. Испорченные — пропускаются. */
  async #history(limit: number): Promise<ResponseBody<HistoryResult>> {
    const rounds: HistoryEntry[] = [];
    for (const { read } of await this.#rounds.latest(Math.min(limit, HISTORY_LIMIT))) {
      if (read.kind !== 'ok') continue;
      const round = read.value;
      const fairness = fairnessOf(round);
      const secret = fairness.commitment === null ? null : await this.#secrets.read(fairness.commitment);
      rounds.push({
        roundId: round.roundId,
        createdAt: round.createdAt,
        betMinor: round.betMinor,
        payX100: round.payX100,
        winMinor: round.winMinor,
        status: round.status,
        ...fairness,
        secret: secret?.kind === 'ok' && secret.value.revealedAt !== null ? secret.value.secret : null,
      });
    }
    return ok({ rounds });
  }

  /** Повтор раунда из своей истории: события и деньги записи, без движения денег. */
  async #replayRound(roundId: string): Promise<ResponseBody<ReplayResult>> {
    const round = this.#usable(await this.#rounds.read(roundId));
    if (round === null) return fail({ code: 'ROUND_NOT_FOUND', roundId });
    return ok({ roundId, bookIndex: null, betMinor: round.betMinor, payX100: round.payX100, winMinor: round.winMinor, events: round.events });
  }

  /** Повтор записи книги в любом браузере: движок по её сиду; ставка — 1.00. */
  #replayBook(index: number): Promise<ResponseBody<ReplayResult>> {
    if (this.#bookLoader === null) return Promise.resolve(fail({ code: 'BAD_REQUEST', message: 'книги нет: источник раундов — живой' }));
    const book = this.#loadedBook();
    if (index >= book.size) return Promise.resolve(fail({ code: 'BAD_REQUEST', message: `индекс книги ${String(index)} вне 0…${String(book.size - 1)}` }));
    const record = book.record(index);
    const played = this.#seeded.play(record.seed);
    if (played.payX100 !== record.payX100) throw new Error(`книга и движок разошлись: запись ${String(index)}`);
    const won = this.#price(REPLAY_BET_MINOR, played.payX100);
    return Promise.resolve(ok({ roundId: null, bookIndex: index, betMinor: REPLAY_BET_MINOR, payX100: played.payX100, winMinor: won, events: played.events }));
  }

  async #resetBalance(): Promise<ResponseBody<BalanceResult>> {
    const state = await this.#load();
    const { wallet, active } = state;
    if (active !== null) return fail({ code: 'ROUND_ACTIVE', roundId: active.roundId });
    const next: WalletRecord = { ...wallet, balanceMinor: START_BALANCE_MINOR, resetSeq: wallet.nextSeq, revision: wallet.revision + 1 };
    await this.#commit(unchanged(state), next, []);
    return ok({ balanceMinor: START_BALANCE_MINOR, wallet: walletView(next, state.repaired) });
  }

  /**
   * Кошелёк и активный раунд через гарды, индекс seq — сверху вниз до первого годного. Испорченное и несогласованное
   * чинится здесь же, отдельной транзакцией, до самой операции.
   */
  async #load(): Promise<Loaded> {
    const wallet = await this.#loadWallet();
    return this.#bookLoader === null ? { ...wallet, fairness: null } : this.#loadFairness(wallet);
  }

  /**
   * Честность под замком (§7): запись цела, её секрет цел, не раскрыт и даёт обязательство, у nonce есть запас. Нет или
   * испорчено — новый секрет и nonce 0 (сид игрока — прежний, если цел), испорченное — в карантин; записано одной
   * транзакцией с ревизией кошелька + 1 — дальше запрос идёт от записанного кошелька. Раунды со старым обязательством
   * остаются в истории, секрет — если был цел.
   */
  async #loadFairness(state: LoadedWallet): Promise<Loaded> {
    const read = await this.#fairness.read();
    const secretRead = read.kind === 'ok' ? await this.#secrets.read(read.value.commitment) : null;
    if (read.kind === 'ok' && secretRead?.kind === 'ok') {
      const secret = secretRead.value;
      const whole = secret.revealedAt === null && (await this.#commitmentOf(secret.secret)) === read.value.commitment && read.value.nonce + 1 <= RECORD_LIMIT;
      if (whole) return { ...state, fairness: { record: read.value, secret } };
    }
    const at = this.#clock.now();
    const ops: WriteOp[] = [];
    if (read.kind === 'damaged') ops.push(quarantined('fairness', read.raw, read.reason, at));
    if (secretRead?.kind === 'damaged') ops.push(quarantined('secrets', secretRead.raw, secretRead.reason, at));
    const fresh = await this.#newSecret(at);
    const clientSeed = read.kind === 'ok' ? read.value.clientSeed : toHex(this.#entropy.bytes(8));
    const record: FairnessRecord = { id: FAIRNESS_ID, commitment: fresh.commitment, clientSeed, nonce: 0 };
    ops.push({ op: 'put', store: 'secrets', value: fresh }, { op: 'put', store: 'fairness', value: record });
    const next: WalletRecord = { ...state.wallet, revision: state.wallet.revision + 1 };
    await this.#commit(unchanged(state), next, ops);
    return { ...state, wallet: next, stored: true, fairness: { record, secret: fresh } };
  }

  /** Новый секрет — 32 криптостойких байта; обязательство — SHA-256 в hex. */
  async #newSecret(at: number): Promise<SecretRecord> {
    const secret = toHex(this.#entropy.bytes(32));
    return { commitment: await this.#commitmentOf(secret), secret, createdAt: at, revealedAt: null };
  }

  async #commitmentOf(secret: string): Promise<string> {
    return toHex(await this.#crypto.sha256(fromHex(secret)));
  }

  async #loadWallet(): Promise<LoadedWallet> {
    const [walletRead, scan] = await Promise.all([this.#wallets.read(), this.#rounds.descend()]);
    if (walletRead.kind === 'absent' && scan.newest === null && scan.above.length === 0) {
      return { wallet: freshWallet(), stored: false, active: null, repaired: false };
    }
    if (walletRead.kind !== 'ok') {
      const reason = walletRead.kind === 'absent' ? 'кошелька нет, а раунды есть' : walletRead.reason;
      return this.#repair(walletRead, this.#orphan(scan.newest), scan, reason);
    }
    const wallet = walletRead.value;
    const activeId = wallet.activeRoundId;
    const activeRead: RoundRead = activeId === null ? { kind: 'absent' } : await this.#rounds.read(activeId);
    const drop = activeId === null ? null : { key: activeId, read: activeRead };
    if (scan.highest >= wallet.nextSeq) return this.#repair(walletRead, drop, scan, 'nextSeq кошелька не впереди раундов');
    if (activeId === null) {
      return this.#roomy(wallet, null) ? { wallet, stored: true, active: null, repaired: false } : this.#repair(walletRead, null, scan, NO_ROOM);
    }
    const active = this.#usable(activeRead);
    if (active?.status !== 'active' || active.balanceAfterBet !== wallet.balanceMinor) {
      return this.#repair(walletRead, drop, scan, activeRead.kind === 'damaged' ? activeRead.reason : 'активный раунд не сходится с кошельком');
    }
    return this.#roomy(wallet, active) ? { wallet, stored: true, active, repaired: false } : this.#repair(walletRead, drop, scan, NO_ROOM);
  }

  /**
   * Запас до границы записей на следующий шаг (§6.6). Без активного раунда кошелёк вмещает целый спин: seq нового
   * раунда, две записи и наибольший выигрыш; с активным — его закрытие. Без запаса своя запись упёрлась бы в гард —
   * INTERNAL на каждый спин. Честной игрой запас не кончается: такой кошелёк испорчен.
   */
  #roomy(wallet: WalletRecord, active: RoundRecord | null): boolean {
    if (active !== null) return wallet.revision + 1 <= RECORD_LIMIT && active.balanceAfterBet + active.winMinor <= RECORD_LIMIT;
    return wallet.nextSeq + 1 <= RECORD_LIMIT && wallet.revision + 2 <= RECORD_LIMIT && wallet.balanceMinor + this.#maxWin <= RECORD_LIMIT;
  }

  /** Кошелька нет или он испорчен: последний раунд снимается, если он не закрыт и цел, — его ставка без кошелька ничья. */
  #orphan(newest: LatestRound | null): { readonly key: StoreKey; readonly read: RoundRead } | null {
    if (newest === null || (newest.read.kind === 'ok' && newest.read.value.status === 'closed')) return null;
    return { key: newest.key, read: newest.read };
  }

  /**
   * Путь «испорчено» (§6.6): сырые записи — в карантин; всё выше годного seq и снятый раунд уходят вместе с ключами;
   * баланс — 1000; nextSeq — годный + 1, годных нет — 1; resetSeq — с этого места. Одна транзакция; условие —
   * кошелёк в том виде, в каком прочитан.
   */
  async #repair(
    walletRead: Read<WalletRecord>,
    drop: { readonly key: StoreKey; readonly read: RoundRead } | null,
    scan: SeqScan,
    reason: string,
  ): Promise<LoadedWallet> {
    const at = this.#clock.now();
    const ops: WriteOp[] = [];
    if (walletRead.kind === 'damaged') ops.push(quarantined('wallet', walletRead.raw, reason, at));
    const removed: StrayRound[] = [...scan.above];
    if (drop !== null && !scan.above.some((stray) => stray.key === drop.key)) {
      removed.push({ key: drop.key, raw: drop.read.kind === 'ok' ? drop.read.value : drop.read.kind === 'damaged' ? drop.read.raw : undefined });
    }
    for (const { key, raw } of removed) {
      if (raw !== undefined) ops.push(quarantined('rounds', raw, reason, at));
      ops.push({ op: 'delete', store: 'rounds', key });
      for (const stale of await this.#keys.ofRound(key)) ops.push({ op: 'delete', store: 'keys', key: stale });
    }
    const nextSeq = scan.newest === null ? 1 : scan.newest.seq + 1;
    const repaired: WalletRecord = {
      id: WALLET_ID,
      balanceMinor: START_BALANCE_MINOR,
      activeRoundId: null,
      nextSeq,
      revision: revisionOf(walletRead) + 1,
      resetSeq: nextSeq,
    };
    const precondition =
      walletRead.kind === 'ok'
        ? unchanged({ wallet: walletRead.value, stored: true, active: null, repaired: false })
        : walletRead.kind === 'absent'
          ? (stored: unknown) => stored === undefined
          : (stored: unknown) => !isWallet(stored);
    await this.#commit(precondition, repaired, ops, 'reset');
    return { wallet: repaired, stored: true, active: null, repaired: true };
  }

  /**
   * Раунд, годный к делу: цел и его выигрыш сходится со ставкой и итогом — как есть. Испорчены только события, а сид
   * и деньги целы — события пересчитываются движком по сиду; совпали итог и выигрыш — раунд продолжается. Иначе null.
   */
  #usable(read: RoundRead): RoundRecord | null {
    if (read.kind === 'ok') return this.#priced(read.value) ? read.value : null;
    if (read.kind === 'absent' || read.core === null) return null;
    const { core } = read;
    try {
      const replayed = this.#seeded.play(core.seed);
      if (replayed.payX100 !== core.payX100 || !this.#priced(core)) return null;
      return { ...core, events: replayed.events };
    } catch (error) {
      if (error instanceof WatchdogError) return null;
      throw error;
    }
  }

  /** Выигрыш записи сходится со ставкой и итогом. Ставка × итог вне точных целых — запись испорчена. */
  #priced(round: RoundCore): boolean {
    try {
      return this.#price(round.betMinor, round.payX100) === round.winMinor;
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
  }

  /** Сетка покоя: итоговая сетка последнего закрытого раунда, пока их нет — заставка. */
  async #idleGrid(): Promise<number[]> {
    for (const { read } of await this.#rounds.latest(2)) {
      const round = this.#usable(read);
      if (round?.status === 'closed') return finalGrid(round.events);
    }
    const first = this.#seeded.play(DEMO_SEED).events[0];
    if (first?.t !== 'fill') throw new Error('заставка: раунд начинается не с fill');
    return [...first.grid];
  }

  /** Выигрыш раунда — единственный вызов winMinor на сервере (§4.6); место закреплено тестом. */
  #price(betMinor: number, payX100: number): number {
    return winMinor(betMinor, payX100);
  }

  /**
   * Одна транзакция: кошелёк и операции. Сервер не пишет того, что сам отвергнет при чтении, — такая запись INTERNAL.
   * Конфликт CAS — WriteConflict; записано — оповещение остальным вкладкам.
   */
  async #commit(precondition: (stored: unknown) => boolean, wallet: WalletRecord, ops: readonly WriteOp[], notice: 'reset' | null = null): Promise<void> {
    const all: WriteOp[] = [{ op: 'put', store: 'wallet', value: wallet }, ...ops];
    for (const op of all) {
      const problem = ownProblem(op);
      if (problem !== null) throw new Error(`запись отвергнута своим же гардом: ${problem}`);
    }
    const outcome = await this.#storage.commit({ precondition, ops: all });
    if (outcome === 'conflict') throw new WriteConflict('кошелёк изменился между чтением и записью');
    try {
      this.#broadcast.walletChanged({
        v: PROTOCOL_VERSION,
        type: 'walletChanged',
        balanceMinor: wallet.balanceMinor,
        activeRoundId: wallet.activeRoundId,
        revision: wallet.revision,
        notice,
      });
    } catch {
      // Оповещение — по возможности: запись уже сделана, ответ уйдёт и без него.
    }
  }
}
