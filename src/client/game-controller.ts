import { initialState, type ClientEvent, type ClientState, type Command, type ShownRound, type StateView } from '../core/fsm/index.ts';
import { finalGrid } from '../core/presentation/final-grid.ts';
import {
  checkStorageClosed,
  checkWalletChanged,
  type AuthenticateResult,
  type ClientConfig,
  type RequestBody,
  type Results,
  type StorageNotice,
  type WalletChanged,
} from '../protocol/index.ts';
import type { KeySource, RoundLease, RoundLock, TabChannel } from './ports.ts';
import type { Presentation } from './presenter.ts';
import type { CallOutcome, Rgs } from './rgs-client.ts';
import { WalletBook, type WalletUpdate } from './wallet-book.ts';

export interface GameControllerPorts {
  readonly rgs: Rgs;
  /** Замок раунда cryscade-round — общий для вкладок (Web Locks). */
  readonly roundLock: RoundLock;
  /** Замок внутри вкладки: хранилище недоступно — вкладки независимы, общий замок им только мешал бы. */
  readonly localLock: RoundLock;
  readonly channel: TabChannel;
  /** Сообщения своего воркера без запроса: storageClosed — базу обновила другая вкладка. */
  readonly notices: TabChannel;
  readonly keys: KeySource;
  /** Показ на сцене (§8.2): сетка покоя и раунды. */
  readonly presentation: Presentation;
}

/** Что повторить по ссылке (§7): раунд своей истории или запись книги — ?replay=round:<id> | ?replay=book:<index>. */
export type ReplayTarget = { readonly round: string } | { readonly book: number };

/** Раунд, закрытый этой вкладкой: пришёл ответ endRound — ставка списана, выигрыш зачислен. Для сессии игрока (§11). */
export interface SettledRound {
  readonly roundId: string;
  readonly betMinor: number;
  readonly winMinor: number;
  /** Баланс после зачисления этого раунда — из ответа endRound. */
  readonly balanceMinor: number;
}

/** Полоса над игрой: хранилище в памяти, починка, база обновлена другой вкладкой. */
export type ClientNotice = StorageNotice | 'versionchange';

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
  readonly notice: ClientNotice | null;
  /** replay — вкладка открыта по ссылке повтора: денег, замков и спина нет. */
  readonly mode: 'play' | 'replay';
}

const DEFAULT_BET_MINOR = 100;

/** Ставка остаётся, пока она есть среди уровней; иначе — 1 кредит, если есть, или наименьшая. */
function pickBet(levels: readonly number[], current: number | null): number | null {
  if (current !== null && levels.includes(current)) return current;
  return levels.includes(DEFAULT_BET_MINOR) ? DEFAULT_BET_MINOR : (levels[0] ?? null);
}

function sameGrid(a: readonly number[] | null, b: readonly number[]): boolean {
  return a !== null && a.length === b.length && a.every((symbol, cell) => symbol === b[cell]);
}

/** mode не сравнивается: он меняется только вместе с состоянием — startReplay действует лишь из booting. */
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
  readonly #presentation: Presentation;
  readonly #wallet = new WalletBook();
  readonly #listeners = new Set<() => void>();
  readonly #settledListeners = new Set<(round: SettledRound) => void>();
  readonly #inbox: ClientEvent[] = [];
  readonly #unlisten: () => void;
  readonly #unlistenNotices: () => void;
  #state: ClientState = initialState();
  #snapshot: ControllerSnapshot;
  #draining = false;
  #disposed = false;
  #bookRequested = false;
  /** Цель повтора; null — обычная игра. */
  #replay: ReplayTarget | null = null;
  /** Хранилище сервера в памяти: вкладки независимы — замок свой, оповещения других вкладок не про наш кошелёк. */
  #volatile = false;
  /** Хранилище чинилось — баланс восстановлен до 1000. */
  #reset = false;
  /** Воркер закрыл хранилище: другая вкладка открыла базу новой версии — играть дальше можно только после перезагрузки. */
  #storageClosed = false;
  /** Оповещения до первого authenticate: ещё не известно, наш ли это кошелёк. */
  #early: unknown[] | null = [];
  #config: ClientConfig | null = null;
  #betMinor: number | null = null;
  #grid: readonly number[] | null = null;
  #winMinor: number | null = null;
  /** Раунд на сцене: его ставка и выигрыш уходят слушателям закрытия, когда придёт ответ endRound. */
  #shown: ShownRound | null = null;
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
    this.#presentation = ports.presentation;
    this.#presentation.listen({
      held: () => {
        this.#dispatch({ type: 'held' });
      },
      finished: () => {
        this.#dispatch({ type: 'presented' });
      },
    });
    this.#snapshot = this.#compose();
    this.#unlisten = ports.channel.listen((message) => {
      this.#fromTab(message);
    });
    this.#unlistenNotices = ports.notices.listen((message) => {
      if (this.#storageClosed || checkStorageClosed(message) !== null) return;
      this.#storageClosed = true;
      if (!this.#draining) this.#publish();
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

  /** Раунды, которые закрыла эта вкладка, — по одному на ответ endRound; свои и доигранные. */
  onRoundSettled(listener: (round: SettledRound) => void): () => void {
    this.#settledListeners.add(listener);
    return () => {
      this.#settledListeners.delete(listener);
    };
  }

  start(): void {
    this.#dispatch({ type: 'start' });
  }

  /**
   * Повтор по ссылке (§7, фаза 6): вместо start — события раунда без authenticate, замков и кошелька; оповещения других
   * вкладок повтору не нужны. Выход — обычный запуск страницы без ?replay.
   */
  startReplay(target: ReplayTarget): void {
    if (this.#state.view.name !== 'booting') return;
    this.#replay = target;
    this.#dispatch({ type: 'replayStart' });
  }

  /** «Спін». Ключ идемпотентности рождается здесь и живёт в данных состояния до ответа на play. */
  spin(): void {
    if (this.#state.view.name !== 'idle' || this.#betMinor === null) return;
    this.#dispatch({ type: 'spin', key: this.#keys.next(), betMinor: this.#betMinor });
  }

  /** Тап по сцене, пробел или «Спін» во время показа: пропуск или «продолжить» на плашке фриспинов. */
  tap(): void {
    this.#dispatch({ type: 'tap' });
  }

  /** «Повторити»: тот же запрос — play с тем же ключом, endRound с тем же roundId. */
  retry(): void {
    this.#dispatch({ type: 'retry' });
  }

  /** «Грати тут»: отнять замок у вкладки, которая показывает раунд. */
  takeOver(): void {
    this.#dispatch({ type: 'takeOver' });
  }

  /** «Поповнити»: баланс снова 1000. */
  refill(): void {
    this.#dispatch({ type: 'refill' });
  }

  /**
   * Книга исходов — загрузить заранее (§5, фаза 6): корень композиции зовёт это после первого кадра сцены, чтобы первый
   * спин её не ждал. Один раз за жизнь контроллера; исход не важен — play всё равно дождётся книги, а сбой загрузки
   * сервер переживает: следующий запрос качает её заново.
   */
  prefetchBook(): void {
    // Повтор не играет: книгу для повтора записи книги сервер грузит сам, по запросу replay.
    if (this.#bookRequested || this.#disposed || this.#replay !== null) return;
    this.#bookRequested = true;
    void this.#rgs.call({ type: 'loadBook' });
  }

  betUp(): void {
    this.#stepBet(1);
  }

  betDown(): void {
    this.#stepBet(-1);
  }

  /** Ставка из списка уровней — выбор в popover панели; только в покое и только уровень конфига. */
  setBet(betMinor: number): void {
    const levels = this.#config?.betLevelsMinor;
    if (levels === undefined || !levels.includes(betMinor) || this.#state.view.name !== 'idle') return;
    this.#betMinor = betMinor;
    this.#publish();
  }

  /** Вкладка закрывается: запрос в пути брошен, замок отпущен; выданный потом — тоже отпускается. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#call?.abort();
    this.#releaseLock();
    this.#unlisten();
    this.#unlistenNotices();
    this.#listeners.clear();
    this.#settledListeners.clear();
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
          this.#settle(command.roundId, result.balanceMinor);
          return { type: 'ended' };
        });
        break;
      case 'callResetBalance':
        this.#request({ type: 'resetBalance' }, (result) => {
          this.#applyWallet(result.wallet);
          return { type: 'refilled' };
        });
        break;
      case 'callReplay': {
        const target = this.#replay;
        if (target === null) break;
        this.#request({ type: 'replay', ...target }, (result) => ({
          type: 'replayLoaded',
          round: { roundId: result.roundId ?? `book-${String(result.bookIndex)}`, betMinor: result.betMinor, winMinor: result.winMinor, events: result.events },
        }));
        break;
      }
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
        this.#presentation.halt();
        break;
      case 'startPresentation':
        this.#present(command.round, command.restored);
        break;
      case 'skipPresentation':
        this.#presentation.skip();
        break;
      case 'resumePresentation':
        this.#presentation.resume();
        break;
      default:
        command satisfies never;
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
    // Сетка покоя — сцене, если на поле другая: сверка под замком и повтор authenticate ту же сетку заново не роняют.
    // Показ раунда начинается только после сверки под замком (restoring), поэтому сверка его и не обрывает.
    if (!sameGrid(this.#grid, result.idleGrid)) this.#presentation.rest(result.idleGrid);
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
    if (this.#replay !== null) return;
    if (this.#early !== null) {
      this.#early.push(message);
      return;
    }
    if (this.#volatile || checkWalletChanged(message) !== null) return;
    this.#applyWallet(message as WalletChanged);
    if (!this.#draining) this.#publish();
  }

  /**
   * Показ раунда на сцене (§8.2): endRound уйдёт, когда показ дойдёт до конца (presented от часов показа). До ответа
   * endRound на панели — баланс после ставки: зачисление приходит с ответом endRound.
   */
  #present(round: ShownRound, restored: boolean): void {
    this.#shown = round;
    this.#grid = finalGrid(round.events);
    this.#winMinor = round.winMinor;
    // В повторе на панели — ставка показанного раунда; баланс не известен и не двигается.
    if (this.#replay !== null) this.#betMinor = round.betMinor;
    this.#presentation.play(round, restored);
  }

  #settle(roundId: string, balanceMinor: number): void {
    // endRound уходит только после показа раунда: на сцене — он.
    const shown = this.#shown;
    if (shown === null) return;
    const round: SettledRound = { roundId, betMinor: shown.betMinor, winMinor: shown.winMinor, balanceMinor };
    for (const listener of [...this.#settledListeners]) listener(round);
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
      notice: this.#storageClosed ? 'versionchange' : this.#volatile ? 'volatile' : this.#reset ? 'reset' : null,
      mode: this.#replay === null ? 'play' : 'replay',
    };
  }

  #publish(): void {
    const next = this.#compose();
    if (sameSnapshot(next, this.#snapshot)) return;
    this.#snapshot = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
