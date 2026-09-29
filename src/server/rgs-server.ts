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
  type PlayResult,
  type ProtocolError,
  type RequestBody,
  type ResponseBody,
  type ResponseEnvelope,
  type RoundView,
  type WalletView,
} from '../protocol/index.ts';
import { COMMIT_ATTEMPTS, DEMO_SEED, HISTORY_LIMIT, SERVER_MAX_REQUESTS } from './limits.ts';
import type { Broadcast, Clock, Entropy, Lock, Storage, StoreKey, StoreName, WriteOp } from './ports.ts';
import {
  RECORD_LIMIT,
  checkKey,
  checkRound,
  checkWallet,
  isWallet,
  type KeyRecord,
  type QuarantineRecord,
  type RoundCore,
  type RoundRecord,
  type WalletRecord,
} from './records.ts';
import {
  IdempotencyRepository,
  RoundRepository,
  WalletRepository,
  type LatestRound,
  type Read,
  type RoundRead,
} from './repositories.ts';
import { LiveRoundSource, type RoundSource } from './round-source.ts';
import { WALLET_ID } from './schema.ts';
import { SeededRounds } from './seeded-rounds.ts';

/** Все изменения кошелька — под этим замком (§6.3): у всех вкладок один писатель. */
export const WALLET_LOCK = 'cryscade-wallet';

export interface RgsServerPorts {
  readonly storage: Storage;
  readonly lock: Lock;
  readonly clock: Clock;
  readonly entropy: Entropy;
  readonly broadcast: Broadcast;
}

export interface RgsServerOptions {
  readonly config: GameConfig;
  /** Порог сторожа; по умолчанию SERVER_MAX_REQUESTS. */
  readonly maxRequests?: number;
}

/** Состояние под замком: кошелёк прошёл гард или починен, активный раунд цел и сходится с кошельком. */
interface Loaded {
  readonly wallet: WalletRecord;
  /** Кошелёк лежит в хранилище. Нет — первый запуск, и условие записи — пустое место. */
  readonly stored: boolean;
  readonly active: RoundRecord | null;
  /** В этом вызове хранилище чинилось: баланс восстановлен до 1000. */
  readonly repaired: boolean;
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
  return { roundId: round.roundId, betMinor: round.betMinor, payX100: round.payX100, winMinor: round.winMinor, events: round.events };
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
function unchanged(state: Loaded): (stored: unknown) => boolean {
  if (!state.stored) return (stored) => stored === undefined;
  const { revision } = state.wallet;
  return (stored) => isWallet(stored) && stored.revision === revision;
}

/** Ревизия, с которой продолжить счёт: у испорченного кошелька — его, если она годится и +1 не выводит за границу. */
function revisionOf(read: Read<WalletRecord>): number {
  if (read.kind === 'ok') return read.value.revision;
  if (read.kind === 'damaged' && isRecord(read.raw) && isIntIn(read.raw['revision'], 0, RECORD_LIMIT - 1)) return read.raw['revision'];
  return 0;
}

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
    case 'quarantine':
      return null;
  }
}

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
  readonly #config: GameConfig;
  readonly #wallets: WalletRepository;
  readonly #rounds: RoundRepository;
  readonly #keys: IdempotencyRepository;
  readonly #seeded: SeededRounds;
  readonly #source: RoundSource;

  constructor(ports: RgsServerPorts, options: RgsServerOptions) {
    this.#storage = ports.storage;
    this.#lock = ports.lock;
    this.#clock = ports.clock;
    this.#entropy = ports.entropy;
    this.#broadcast = ports.broadcast;
    this.#config = options.config;
    this.#wallets = new WalletRepository(ports.storage);
    this.#rounds = new RoundRepository(ports.storage);
    this.#keys = new IdempotencyRepository(ports.storage);
    this.#seeded = new SeededRounds(options.config, options.maxRequests ?? SERVER_MAX_REQUESTS);
    this.#source = new LiveRoundSource(ports.entropy, this.#seeded);
  }

  /** Запрос → ответ. Не бросает: любой сбой — INTERNAL, а транзакция либо записана целиком, либо не записана. */
  async handle(raw: unknown): Promise<ResponseEnvelope> {
    const request = parseRequest(raw);
    if (!request.ok) return responseEnvelope(request.id, fail(request.error));
    const { id, body } = request;
    if (body.type === 'play' && !isBetLevel(body.betMinor)) return responseEnvelope(id, fail({ code: 'INVALID_BET', betMinor: body.betMinor }));
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
    }
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

    // Энтропия и движок — до транзакции: сработавший сторож не оставляет ни одной записи.
    const draw = this.#source.draw();
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
    };
    const keyRecord: KeyRecord = { key, roundId: round.roundId, betMinor };
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

  async #resetBalance(): Promise<ResponseBody<BalanceResult>> {
    const state = await this.#load();
    const { wallet, active } = state;
    if (active !== null) return fail({ code: 'ROUND_ACTIVE', roundId: active.roundId });
    const next: WalletRecord = { ...wallet, balanceMinor: START_BALANCE_MINOR, resetSeq: wallet.nextSeq, revision: wallet.revision + 1 };
    await this.#commit(unchanged(state), next, []);
    return ok({ balanceMinor: START_BALANCE_MINOR, wallet: walletView(next, state.repaired) });
  }

  /** Кошелёк и активный раунд через гарды. Испорченное чинится здесь же, отдельной транзакцией, до самой операции. */
  async #load(): Promise<Loaded> {
    const [walletRead, latest] = await Promise.all([this.#wallets.read(), this.#rounds.latest(1)]);
    const newest = latest[0] ?? null;
    const newestSeq = newest?.seq ?? 0;
    if (walletRead.kind === 'absent' && newest === null) return { wallet: freshWallet(), stored: false, active: null, repaired: false };
    if (walletRead.kind !== 'ok') {
      const reason = walletRead.kind === 'absent' ? 'кошелька нет, а раунды есть' : walletRead.reason;
      return this.#repair(walletRead, this.#orphan(newest), newestSeq, reason);
    }
    const wallet = walletRead.value;
    const activeId = wallet.activeRoundId;
    const activeRead: RoundRead = activeId === null ? { kind: 'absent' } : await this.#rounds.read(activeId);
    const drop = activeId === null ? null : { key: activeId, read: activeRead };
    if (newestSeq >= wallet.nextSeq) return this.#repair(walletRead, drop, newestSeq, 'nextSeq кошелька не впереди раундов');
    if (activeId === null) return { wallet, stored: true, active: null, repaired: false };
    const active = this.#usable(activeRead);
    if (active?.status !== 'active' || active.balanceAfterBet !== wallet.balanceMinor) {
      return this.#repair(walletRead, drop, newestSeq, activeRead.kind === 'damaged' ? activeRead.reason : 'активный раунд не сходится с кошельком');
    }
    return { wallet, stored: true, active, repaired: false };
  }

  /** Кошелька нет или он испорчен: последний раунд снимается, если он не закрыт и цел, — его ставка без кошелька ничья. */
  #orphan(newest: LatestRound | null): { readonly key: StoreKey; readonly read: RoundRead } | null {
    if (newest === null || (newest.read.kind === 'ok' && newest.read.value.status === 'closed')) return null;
    return { key: newest.key, read: newest.read };
  }

  /**
   * Путь «испорчено» (§6.6): сырые записи — в карантин, снятый раунд уходит вместе с ключами, баланс — 1000,
   * resetSeq — с этого места. Одна транзакция; условие — кошелёк в том виде, в каком прочитан.
   */
  async #repair(
    walletRead: Read<WalletRecord>,
    drop: { readonly key: StoreKey; readonly read: RoundRead } | null,
    newestSeq: number,
    reason: string,
  ): Promise<Loaded> {
    const at = this.#clock.now();
    const ops: WriteOp[] = [];
    if (walletRead.kind === 'damaged') ops.push(quarantined('wallet', walletRead.raw, reason, at));
    if (drop !== null) {
      const raw = drop.read.kind === 'ok' ? drop.read.value : drop.read.kind === 'damaged' ? drop.read.raw : undefined;
      if (raw !== undefined) ops.push(quarantined('rounds', raw, reason, at));
      ops.push({ op: 'delete', store: 'rounds', key: drop.key });
      for (const stale of await this.#keys.ofRound(drop.key)) ops.push({ op: 'delete', store: 'keys', key: stale });
    }
    const valid = walletRead.kind === 'ok' ? walletRead.value : null;
    const nextSeq = Math.max(newestSeq + 1, valid?.nextSeq ?? 1);
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
