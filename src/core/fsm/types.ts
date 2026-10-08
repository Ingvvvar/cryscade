import type { RoundEvent } from '../model/events.ts';

// Машина состояний клиента (§8.1), паттерн State. Состояние — неизменяемый объект с данными, переход — чистый метод
// on(event) → { state, commands }. События — что случилось: ввод игрока, ответ сервера, замок раунда. Команды — что
// сделать; исполняет их контроллер. Всё здесь — простые данные.

/** Раунд для показа: всё, что машине и презентации нужно от ответа сервера. */
export interface ShownRound {
  readonly roundId: string;
  readonly betMinor: number;
  readonly winMinor: number;
  readonly events: readonly RoundEvent[];
}

/** Отказ сервера — коды ошибок протокола v1 (§6.1). Контроллер передаёт код как есть, совпадение типов сверяет компилятор. */
export type RejectCode =
  | 'INSUFFICIENT_FUNDS'
  | 'ROUND_ACTIVE'
  | 'ROUND_NOT_FOUND'
  | 'INVALID_BET'
  | 'IDEMPOTENCY_CONFLICT'
  | 'BAD_REQUEST'
  | 'VERSION_MISMATCH'
  | 'INTERNAL';

export type ClientEvent =
  /** Контроллер запущен. */
  | { readonly type: 'start' }
  /** Запуск повтора по ссылке (?replay=): без authenticate, замков и кошелька (фаза 6, §7). */
  | { readonly type: 'replayStart' }
  /** Сервер отдал события повторяемого раунда. */
  | { readonly type: 'replayLoaded'; readonly round: ShownRound }
  /** «Спін»: ключ идемпотентности рождается при нажатии и живёт до ответа на play. */
  | { readonly type: 'spin'; readonly key: string; readonly betMinor: number }
  /** «Повторити» на экране ошибки. */
  | { readonly type: 'retry' }
  /** «Грати тут»: отнять замок раунда у другой вкладки. */
  | { readonly type: 'takeOver' }
  /** «Поповнити»: баланс снова 1000 (§4.6). */
  | { readonly type: 'refill' }
  /** Замок раунда выдан: сразу, из очереди или перехватом. */
  | { readonly type: 'lockGranted' }
  /** Замок держит другая вкладка. */
  | { readonly type: 'lockBusy' }
  /** Замок отняла другая вкладка. */
  | { readonly type: 'lockLost' }
  | { readonly type: 'authenticated'; readonly activeRound: ShownRound | null }
  | { readonly type: 'played'; readonly round: ShownRound }
  /** Показ раунда закончен: часы показа дошли до конца, после счётчика. */
  | { readonly type: 'presented' }
  /** Часы показа встали на точке удержания featureIntro: плашка фриспинов ждёт игрока. */
  | { readonly type: 'held' }
  /** Тап по сцене, пробел или «Спін» во время показа: пропуск (slam stop) или «продолжить» на featureIntro. */
  | { readonly type: 'tap' }
  | { readonly type: 'ended' }
  /** resetBalance прошёл. */
  | { readonly type: 'refilled' }
  /** Сервер ответил ошибкой. */
  | { readonly type: 'rejected'; readonly code: RejectCode }
  /** Все попытки потеряны: таймауты и потери транспорта. */
  | { readonly type: 'unreachable' }
  /** Ответ не прошёл гард или пришёл от сервера другой версии. */
  | { readonly type: 'unusable'; readonly reason: 'version' | 'invalid' };

/** Что повторяет «Повторити»: тот же запрос — play с тем же ключом, endRound с тем же roundId. */
export type RetryTarget =
  | { readonly call: 'authenticate' }
  | { readonly call: 'play'; readonly key: string; readonly betMinor: number }
  | { readonly call: 'endRound'; readonly roundId: string }
  | { readonly call: 'resetBalance' }
  | { readonly call: 'replay' };

export type Command =
  | { readonly type: 'callAuthenticate' }
  | { readonly type: 'callPlay'; readonly key: string; readonly betMinor: number }
  | { readonly type: 'callEndRound'; readonly roundId: string }
  | { readonly type: 'callResetBalance' }
  /** Запросить события повторяемого раунда; цель повтора знает контроллер. */
  | { readonly type: 'callReplay' }
  /** Взять замок раунда, если свободен (ifAvailable). Ответ — lockGranted или lockBusy. */
  | { readonly type: 'takeLock' }
  /** Встать в очередь на замок. Ответ — lockGranted, когда хозяин отпустит или закроется. */
  | { readonly type: 'queueForLock' }
  /** Выйти из очереди и отнять замок у хозяина (steal). Ответ — lockGranted. */
  | { readonly type: 'stealLock' }
  | { readonly type: 'releaseLock' }
  /** Бросить начатое — запрос в пути и показ: замок отняли, раунд доиграет другая вкладка. */
  | { readonly type: 'abandon' }
  | { readonly type: 'startPresentation'; readonly round: ShownRound; readonly restored: boolean }
  /** Пропуск показа: первый — к концу текущей группы, следующий — к концу раунда. Пресет без пропуска его не исполняет. */
  | { readonly type: 'skipPresentation' }
  /** Часы показа идут дальше с точки удержания featureIntro. */
  | { readonly type: 'resumePresentation' };

/**
 * Почему вкладка на экране ошибки. version и client лечит только перезагрузка, missing — выход из повтора (ссылка ведёт
 * в никуда), остальное — «Повторити».
 */
export type ErrorKind = 'unreachable' | 'server' | 'invalid' | 'version' | 'client' | 'missing';

/** Состояние снаружи — простые данные: для снимка контроллера и для тестов. */
export type StateView =
  | { readonly name: 'booting' }
  | { readonly name: 'authenticating'; readonly holdsLock: boolean }
  /** refusal — чем сервер отказал последнему спину: он не состоялся, деньги не двигались. */
  | { readonly name: 'idle'; readonly refusal: RejectCode | null }
  | { readonly name: 'requesting'; readonly stage: 'lock' | 'play'; readonly key: string; readonly betMinor: number }
  | { readonly name: 'presenting'; readonly roundId: string }
  /** Показ стоит на плашке фриспинов и ждёт тапа или пробела; замок раунда у вкладки. */
  | { readonly name: 'featureIntro'; readonly roundId: string }
  | { readonly name: 'ending'; readonly roundId: string }
  | { readonly name: 'restoring'; readonly stage: 'lock'; readonly roundId: null }
  | { readonly name: 'restoring'; readonly stage: 'show'; readonly roundId: string }
  | { readonly name: 'waitingForTab'; readonly stealing: boolean }
  /** resetBalance в пути. Замок раунда не нужен: при активном раунде сервер ответит ROUND_ACTIVE. */
  | { readonly name: 'refilling' }
  /**
   * Повтор по ссылке: loading — события в пути, showing — показ, held — показ стоит на плашке фриспинов, done — показан.
   * Денег, замков и спина в повторе нет.
   */
  | { readonly name: 'replaying'; readonly stage: 'loading' | 'showing' | 'held' | 'done'; readonly roundId: string | null }
  | { readonly name: 'error'; readonly kind: ErrorKind; readonly retry: RetryTarget | null; readonly holdsLock: boolean };

export interface Transition {
  readonly state: ClientState;
  readonly commands: readonly Command[];
  /** Пара (состояние, событие) недопустима: состояние то же, команд нет. */
  readonly ignored: boolean;
}

export interface ClientState {
  readonly view: StateView;
  /** Держит ли вкладка в этом состоянии замок раунда. */
  readonly holdsLock: boolean;
  on(event: ClientEvent): Transition;
}
