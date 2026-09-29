import { initialState, type ClientEvent, type ClientState, type Command, type ShownRound, type StateView } from '../core/fsm/index.ts';
import { finalGrid } from '../core/presentation/final-grid.ts';
import {
  checkWalletChanged,
  type AuthenticateResult,
  type ClientConfig,
  type RequestBody,
  type Results,
  type StorageNotice,
  type WalletChanged,
} from '../protocol/index.ts';
import type { KeySource, RoundLease, RoundLock, TabChannel } from './ports.ts';
import type { CallOutcome, Rgs } from './rgs-client.ts';
import { WalletBook, type WalletUpdate } from './wallet-book.ts';

export interface GameControllerPorts {
  readonly rgs: Rgs;
  /** Замок раунда cryscade-round — общий для вкладок (Web Locks). */
  readonly roundLock: RoundLock;
  /** Замок внутри вкладки: хранилище недоступно — вкладки независимы, общий замок им только мешал бы. */
  readonly localLock: RoundLock;
  readonly channel: TabChannel;
  readonly keys: KeySource;
}

/** Снимок для ui/ (useSyncExternalStore): новый объект — только когда что-то в нём изменилось. */
export interface ControllerSnapshot {
  readonly state: StateView;
  /** null — до первого authenticate. */
  readonly balanceMinor: number | null;
  readonly betMinor: number | null;
  readonly betLevelsMinor: readonly number[];
  /** Сетка на поле: покоя, потом итоговая сетка показанного раунда. null — до первого authenticate. */
  readonly grid: readonly number[] | null;
  /** Выигрыш последнего показанного раунда. */
  readonly winMinor: number | null;
  readonly notice: StorageNotice | null;
}

const DEFAULT_BET_MINOR = 100;

/** Ставка остаётся, пока она есть среди уровней; иначе — 1 кредит, если есть, или наименьшая. */
function pickBet(levels: readonly number[], current: number | null): number | null {
  if (current !== null && levels.includes(current)) return current;
  return levels.includes(DEFAULT_BET_MINOR) ? DEFAULT_BET_MINOR : (levels[0] ?? null);
}

function sameSnapshot(a: ControllerSnapshot, b: ControllerSnapshot): boolean {
  return (
    a.state === b.state &&
    a.balanceMinor === b.balanceMinor &&
    a.betMinor === b.betMinor &&
    a.betLevelsMinor === b.betLevelsMinor &&
    a.grid === b.grid &&
    a.winMinor === b.winMinor &&
    a.notice === b.notice
  );
}

interface Queued {
  readonly cancel: AbortController;
  readonly lease: Promise<RoundLease>;
}

/**
 * Контроллер игры — фасад для ui/ (§3). Держит машину состояний и исполняет её команды: запросы к RGS, замок раунда,
 * показ. Замок cryscade-round берётся до play и держится до ответа endRound; пока он у другой вкладки, play не уходит
 * (§6.5). Баланс — по revision из ответов сервера и оповещений других вкладок. Создаётся в корне композиции вне React.
 */
export class GameController {
  readonly #rgs: Rgs;
  readonly #roundLock: RoundLock;
  readonly #localLock: RoundLock;
  readonly #keys: KeySource;
  readonly #wallet = new WalletBook();
  readonly #listeners = new Set<() => void>();
  readonly #inbox: ClientEvent[] = [];
  readonly #unlisten: () => void;
  #state: ClientState = initialState();
  #snapshot: ControllerSnapshot;
  #draining = false;
  #disposed = false;
  /** Хранилище сервера в памяти: вкладки независимы — замок свой, оповещения других вкладок не про наш кошелёк. */
  #volatile = false;
  /** Хранилище чинилось — баланс восстановлен до 1000. */
  #reset = false;
  /** Оповещения до первого authenticate: ещё не известно, наш ли это кошелёк. */
  #early: unknown[] | null = [];
  #config: ClientConfig | null = null;
  #betMinor: number | null = null;
  #grid: readonly number[] | null = null;
  #winMinor: number | null = null;
  #lease: RoundLease | null = null;
  /** Запрос в очереди на замок: его снимает перехват. */
  #queued: Queued | null = null;
  /** Последний начатый запрос. abandon и dispose его обрывают, и исход оборванного уже никого не касается. */
  #call: AbortController | null = null;

  constructor(ports: GameControllerPorts) {
    this.#rgs = ports.rgs;
    this.#roundLock = ports.roundLock;
    this.#localLock = ports.localLock;
    this.#keys = ports.keys;
    this.#snapshot = this.#compose();
    this.#unlisten = ports.channel.listen((message) => {
      this.#fromTab(message);
    });
  }

  getSnapshot(): ControllerSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  start(): void {
    this.#dispatch({ type: 'start' });
  }

  /** «Спін». Ключ идемпотентности рождается здесь и живёт в данных состояния до ответа на play. */
  spin(): void {
    if (this.#state.view.name !== 'idle' || this.#betMinor === null) return;
    this.#dispatch({ type: 'spin', key: this.#keys.next(), betMinor: this.#betMinor });
  }

  /** «Повторити»: тот же запрос — play с тем же ключом, endRound с тем же roundId. */
  retry(): void {
    this.#dispatch({ type: 'retry' });
  }

  /** «Грати тут»: отнять замок у вкладки, которая показывает раунд. */
  takeOver(): void {
    this.#dispatch({ type: 'takeOver' });
  }

  betUp(): void {
    this.#stepBet(1);
  }

  betDown(): void {
    this.#stepBet(-1);
  }

  /** Вкладка закрывается: запрос в пути брошен, замок отпущен; выданный потом — тоже отпускается. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#call?.abort();
    this.#releaseLock();
    this.#unlisten();
    this.#listeners.clear();
  }

  #dispatch(event: ClientEvent): void {
    if (this.#disposed) return;
    this.#inbox.push(event);
    if (this.#draining) return;
    this.#draining = true;
    for (let next = this.#inbox.shift(); next !== undefined; next = this.#inbox.shift()) {
      const transition = this.#state.on(next);
      this.#state = transition.state;
      for (const command of transition.commands) this.#run(command);
    }
    this.#draining = false;
    this.#publish();
  }

  #run(command: Command): void {
    switch (command.type) {
      case 'callAuthenticate':
        this.#request({ type: 'authenticate' }, (result) => this.#authenticated(result));
        break;
      case 'callPlay':
        this.#request({ type: 'play', betMinor: command.betMinor, idempotencyKey: command.key }, (result) => {
          this.#applyWallet(result.wallet);
          return { type: 'played', round: result.round };
        });
        break;
      case 'callEndRound':
        this.#request({ type: 'endRound', roundId: command.roundId }, (result) => {
          this.#applyWallet(result.wallet);
          return { type: 'ended' };
        });
        break;
      case 'takeLock':
        void this.#takeLock();
        break;
      case 'queueForLock':
        this.#queueForLock();
        break;
      case 'stealLock':
        void this.#stealLock();
        break;
      case 'releaseLock':
        this.#releaseLock();
        break;
      case 'abandon':
        this.#call?.abort();
        break;
      case 'startPresentation':
        this.#present(command.round);
        break;
    }
  }

  #request<B extends RequestBody>(body: B, onResult: (result: Results[B['type']]) => ClientEvent): void {
    const call = new AbortController();
    this.#call = call;
    void this.#rgs
      .call(body, call.signal)
      .catch((): CallOutcome<Results[B['type']]> => ({ kind: 'unreachable' }))
      .then((outcome) => {
        if (call.signal.aborted || this.#disposed) return;
        const event = this.#eventOf(outcome, onResult);
        if (event !== null) this.#dispatch(event);
      });
  }

  #eventOf<T>(outcome: CallOutcome<T>, onResult: (result: T) => ClientEvent): ClientEvent | null {
    switch (outcome.kind) {
      case 'ok':
        return onResult(outcome.result);
      case 'rejected':
        return { type: 'rejected', code: outcome.error.code };
      case 'unreachable':
        return { type: 'unreachable' };
      case 'unusable':
        return { type: 'unusable', reason: outcome.reason };
      case 'abandoned':
        return null;
    }
  }

  #authenticated(result: AuthenticateResult): ClientEvent {
    // reset здесь не нужен: о починке говорит кошелёк ответа.
    if (result.notice === 'volatile') this.#volatile = true;
    this.#config = result.config;
    this.#betMinor = pickBet(result.config.betLevelsMinor, this.#betMinor);
    this.#grid = result.idleGrid;
    this.#applyWallet(result.wallet);
    const early = this.#early;
    this.#early = null;
    for (const message of early ?? []) this.#fromTab(message);
    return { type: 'authenticated', activeRound: result.activeRound };
  }

  #applyWallet(update: WalletUpdate): void {
    if (this.#wallet.apply(update) && update.notice === 'reset') this.#reset = true;
  }

  #fromTab(message: unknown): void {
    if (this.#early !== null) {
      this.#early.push(message);
      return;
    }
    if (this.#volatile || checkWalletChanged(message) !== null) return;
    this.#applyWallet(message as WalletChanged);
    if (!this.#draining) this.#publish();
  }

  /** Фаза 4: показ мгновенный — итоговая сетка раунда и сразу endRound (§15). Расписание и падение — фаза 5. */
  #present(round: ShownRound): void {
    this.#grid = finalGrid(round.events);
    this.#winMinor = round.winMinor;
    this.#dispatch({ type: 'presented' });
  }

  #lock(): RoundLock {
    return this.#volatile ? this.#localLock : this.#roundLock;
  }

  async #takeLock(): Promise<void> {
    const lease = await this.#lock().tryAcquire();
    if (lease === null) this.#dispatch({ type: 'lockBusy' });
    else this.#adopt(lease);
  }

  #queueForLock(): void {
    const cancel = new AbortController();
    const lease = this.#lock().acquire(cancel.signal);
    this.#queued = { cancel, lease };
    // Выданный очередью замок принимает только этот обработчик — и тогда, когда очередь уже снимал перехват.
    void lease.then(
      (granted) => {
        this.#adopt(granted);
      },
      () => undefined,
    );
  }

  async #stealLock(): Promise<void> {
    const queued = this.#queued;
    this.#queued = null;
    if (queued !== null) {
      queued.cancel.abort();
      // Очередь успела выдать замок раньше, чем её сняли: он уже наш, отнимать не у кого.
      if (await queued.lease.then(() => true, () => false)) return;
    }
    this.#adopt(await this.#lock().steal());
  }

  #adopt(lease: RoundLease): void {
    if (this.#disposed) {
      lease.release();
      return;
    }
    this.#lease = lease;
    void lease.lost.then(() => {
      if (this.#lease !== lease) return;
      this.#lease = null;
      this.#dispatch({ type: 'lockLost' });
    });
    this.#dispatch({ type: 'lockGranted' });
  }

  #releaseLock(): void {
    const lease = this.#lease;
    this.#lease = null;
    lease?.release();
  }

  #stepBet(step: number): void {
    const levels = this.#config?.betLevelsMinor;
    if (levels === undefined || this.#betMinor === null || this.#state.view.name !== 'idle') return;
    const index = levels.indexOf(this.#betMinor) + step;
    const next = levels[Math.min(levels.length - 1, Math.max(0, index))];
    if (next === undefined) return;
    this.#betMinor = next;
    this.#publish();
  }

  #compose(): ControllerSnapshot {
    return {
      state: this.#state.view,
      balanceMinor: this.#wallet.balanceMinor,
      betMinor: this.#betMinor,
      betLevelsMinor: this.#config?.betLevelsMinor ?? [],
      grid: this.#grid,
      winMinor: this.#winMinor,
      notice: this.#volatile ? 'volatile' : this.#reset ? 'reset' : null,
    };
  }

  #publish(): void {
    const next = this.#compose();
    if (sameSnapshot(next, this.#snapshot)) return;
    this.#snapshot = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
