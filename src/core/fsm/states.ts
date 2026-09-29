import type { ClientEvent, ClientState, Command, ErrorKind, RejectCode, RetryTarget, ShownRound, StateView, Transition } from './types.ts';

// Состояния клиента (§8.1). Замок раунда cryscade-round вкладка берёт до play и держит до ответа endRound (§6.5).
// Раунд доигрывает только вкладка с замком и только по authenticate, полученному под замком: иначе раунд, который
// хозяин успел закончить между authenticate и захватом, показался бы второй раз. В фазе 5 придёт featureIntro,
// в фазе 6 — replaying.
// Полнота — `satisfies never` в switch каждого состояния: новое событие не скомпилируется, пока каждое состояние не
// решит, что с ним делать. Недопустимая пара возвращает то же состояние с пометкой ignored и не бросает.

const AUTHENTICATE: Command = { type: 'callAuthenticate' };
const TAKE_LOCK: Command = { type: 'takeLock' };
const QUEUE: Command = { type: 'queueForLock' };
const STEAL: Command = { type: 'stealLock' };
const RELEASE: Command = { type: 'releaseLock' };
const ABANDON: Command = { type: 'abandon' };
const RESET_BALANCE: Command = { type: 'callResetBalance' };

function stay(state: ClientState): Transition {
  return { state, commands: [], ignored: true };
}

function to(state: ClientState, ...commands: Command[]): Transition {
  return { state, commands, ignored: false };
}

type Failure = Extract<ClientEvent, { readonly type: 'rejected' | 'unreachable' | 'unusable' }>;

const REFILL: RetryTarget = { call: 'resetBalance' };

/**
 * Запрос не дал результата. Сбой транспорта, ошибка сервера и негодный ответ — экран ошибки с «Повторити» того же
 * запроса, замок остаётся у вкладки. Чужая версия и BAD_REQUEST повтором не лечатся: экран с перезагрузкой, а замок
 * отпускается, чтобы другие вкладки не ждали.
 */
function failed(retry: RetryTarget, holdsLock: boolean, failure: Failure): Transition {
  const fatal = (kind: ErrorKind): Transition => {
    const state = new ErrorState(kind, null, false);
    return holdsLock ? to(state, RELEASE) : to(state);
  };
  switch (failure.type) {
    case 'unreachable':
      return to(new ErrorState('unreachable', retry, holdsLock));
    case 'unusable':
      return failure.reason === 'version' ? fatal('version') : to(new ErrorState('invalid', retry, holdsLock));
    case 'rejected':
      switch (failure.code) {
        case 'VERSION_MISMATCH':
          return fatal('version');
        case 'BAD_REQUEST':
          return fatal('client');
        case 'INTERNAL':
          return to(new ErrorState('server', retry, holdsLock));
        default:
          // Код, которого этот запрос не ждёт, — ответ не по протоколу.
          return to(new ErrorState('invalid', retry, holdsLock));
      }
  }
}

/** Замок отняла другая вкладка: начатое брошено, вкладка встаёт в очередь. Раунд доиграет та, что отняла. */
function displaced(): Transition {
  return to(new WaitingForTabState(false), ABANDON, QUEUE);
}

export class BootingState implements ClientState {
  readonly view: StateView = { name: 'booting' };
  readonly holdsLock = false;

  on(event: ClientEvent): Transition {
    switch (event.type) {
      case 'start':
        return to(new AuthenticatingState(false), AUTHENTICATE);
      case 'spin':
      case 'retry':
      case 'takeOver':
      case 'lockGranted':
      case 'lockBusy':
      case 'lockLost':
      case 'authenticated':
      case 'played':
      case 'presented':
      case 'ended':
      case 'rejected':
      case 'unreachable':
      case 'unusable':
      case 'refill':
      case 'refilled':
        return stay(this);
      default:
        event satisfies never;
        return stay(this);
    }
  }
}

/** authenticate в пути. Под замком — сверка после захвата: её ответу можно верить, раунд доигрывается. */
export class AuthenticatingState implements ClientState {
  readonly view: StateView;
  readonly holdsLock: boolean;

  constructor(holdsLock: boolean) {
    this.holdsLock = holdsLock;
    this.view = { name: 'authenticating', holdsLock };
  }

  on(event: ClientEvent): Transition {
    switch (event.type) {
      case 'authenticated':
        return this.#authenticated(event.activeRound);
      case 'rejected':
      case 'unreachable':
      case 'unusable':
        return failed({ call: 'authenticate' }, this.holdsLock, event);
      case 'lockLost':
        return this.holdsLock ? displaced() : stay(this);
      case 'start':
      case 'spin':
      case 'retry':
      case 'takeOver':
      case 'lockGranted':
      case 'lockBusy':
      case 'played':
      case 'presented':
      case 'ended':
      case 'refill':
      case 'refilled':
        return stay(this);
      default:
        event satisfies never;
        return stay(this);
    }
  }

  #authenticated(round: ShownRound | null): Transition {
    if (!this.holdsLock) {
      // Без замка ответу не верим: раунд, может быть, показывает хозяин. Сначала замок, потом сверка под ним.
      return round === null ? to(new IdleState(null)) : to(new RestoringState(null), TAKE_LOCK);
    }
    if (round === null) return to(new IdleState(null), RELEASE);
    return to(new RestoringState(round), { type: 'startPresentation', round, restored: true });
  }
}

export class IdleState implements ClientState {
  readonly view: StateView;
  readonly holdsLock = false;

  constructor(refusal: RejectCode | null) {
    this.view = { name: 'idle', refusal };
  }

  on(event: ClientEvent): Transition {
    switch (event.type) {
      case 'spin':
        return to(new RequestingState('lock', event.key, event.betMinor), TAKE_LOCK);
      case 'refill':
        return to(new RefillingState(), RESET_BALANCE);
      case 'start':
      case 'retry':
      case 'takeOver':
      case 'lockGranted':
      case 'lockBusy':
      case 'lockLost':
      case 'authenticated':
      case 'played':
      case 'presented':
      case 'ended':
      case 'rejected':
      case 'unreachable':
      case 'unusable':
      case 'refilled':
        return stay(this);
      default:
        event satisfies never;
        return stay(this);
    }
  }
}

/** Спин: сначала замок раунда, потом play. Замок занят — play не уходит вовсе. */
export class RequestingState implements ClientState {
  readonly view: StateView;
  readonly holdsLock: boolean;
  readonly #stage: 'lock' | 'play';
  readonly #key: string;
  readonly #betMinor: number;

  constructor(stage: 'lock' | 'play', key: string, betMinor: number) {
    this.#stage = stage;
    this.#key = key;
    this.#betMinor = betMinor;
    this.holdsLock = stage === 'play';
    this.view = { name: 'requesting', stage, key, betMinor };
  }

  on(event: ClientEvent): Transition {
    return this.#stage === 'lock' ? this.#claiming(event) : this.#playing(event);
  }

  #claiming(event: ClientEvent): Transition {
    switch (event.type) {
      case 'lockGranted':
        return to(new RequestingState('play', this.#key, this.#betMinor), { type: 'callPlay', key: this.#key, betMinor: this.#betMinor });
      case 'lockBusy':
        return to(new WaitingForTabState(false), QUEUE);
      case 'start':
      case 'spin':
      case 'retry':
      case 'takeOver':
      case 'lockLost':
      case 'authenticated':
      case 'played':
      case 'presented':
      case 'ended':
      case 'rejected':
      case 'unreachable':
      case 'unusable':
      case 'refill':
      case 'refilled':
        return stay(this);
      default:
        event satisfies never;
        return stay(this);
    }
  }

  #playing(event: ClientEvent): Transition {
    switch (event.type) {
      case 'played':
        return to(new PresentingState(event.round.roundId), { type: 'startPresentation', round: event.round, restored: false });
      case 'rejected':
        return this.#rejected(event);
      case 'unreachable':
      case 'unusable':
        return failed(this.#retry(), true, event);
      case 'lockLost':
        return displaced();
      case 'start':
      case 'spin':
      case 'retry':
      case 'takeOver':
      case 'lockGranted':
      case 'lockBusy':
      case 'authenticated':
      case 'presented':
      case 'ended':
      case 'refill':
      case 'refilled':
        return stay(this);
      default:
        event satisfies never;
        return stay(this);
    }
  }

  #rejected(failure: Extract<ClientEvent, { readonly type: 'rejected' }>): Transition {
    switch (failure.code) {
      case 'ROUND_ACTIVE':
        // Замок у нас, а раунд активен — хозяин закрылся или упал. Доиграть его, сверившись под замком.
        return to(new AuthenticatingState(true), AUTHENTICATE);
      case 'INSUFFICIENT_FUNDS':
      case 'INVALID_BET':
      case 'IDEMPOTENCY_CONFLICT':
      case 'ROUND_NOT_FOUND':
        // Спин не состоялся и с этим ключом не состоится.
        return to(new IdleState(failure.code), RELEASE);
      case 'BAD_REQUEST':
      case 'VERSION_MISMATCH':
      case 'INTERNAL':
        return failed(this.#retry(), true, failure);
    }
  }

  #retry(): RetryTarget {
    return { call: 'play', key: this.#key, betMinor: this.#betMinor };
  }
}

/** Показ раунда из ответа play. В фазе 4 он мгновенный: итоговая сетка и сразу endRound. */
export class PresentingState implements ClientState {
  readonly view: StateView;
  readonly holdsLock = true;
  readonly #roundId: string;

  constructor(roundId: string) {
    this.#roundId = roundId;
    this.view = { name: 'presenting', roundId };
  }

  on(event: ClientEvent): Transition {
    switch (event.type) {
      case 'presented':
        return to(new EndingState(this.#roundId), { type: 'callEndRound', roundId: this.#roundId });
      case 'lockLost':
        return displaced();
      case 'start':
      case 'spin':
      case 'retry':
      case 'takeOver':
      case 'lockGranted':
      case 'lockBusy':
      case 'authenticated':
      case 'played':
      case 'ended':
      case 'rejected':
      case 'unreachable':
      case 'unusable':
      case 'refill':
      case 'refilled':
        return stay(this);
      default:
        event satisfies never;
        return stay(this);
    }
  }
}

/** endRound в пути; замок отпускается только после ответа. */
export class EndingState implements ClientState {
  readonly view: StateView;
  readonly holdsLock = true;
  readonly #roundId: string;

  constructor(roundId: string) {
    this.#roundId = roundId;
    this.view = { name: 'ending', roundId };
  }

  on(event: ClientEvent): Transition {
    switch (event.type) {
      case 'ended':
        return to(new IdleState(null), RELEASE);
      case 'rejected':
        // Раунда нет — его сняла починка хранилища в другой вкладке. Сверка под замком покажет, что теперь.
        if (event.code === 'ROUND_NOT_FOUND') return to(new AuthenticatingState(true), AUTHENTICATE);
        return failed(this.#retry(), true, event);
      case 'unreachable':
      case 'unusable':
        return failed(this.#retry(), true, event);
      case 'lockLost':
        return displaced();
      case 'start':
      case 'spin':
      case 'retry':
      case 'takeOver':
      case 'lockGranted':
      case 'lockBusy':
      case 'authenticated':
      case 'played':
      case 'presented':
      case 'refill':
      case 'refilled':
        return stay(this);
      default:
        event satisfies never;
        return stay(this);
    }
  }

  #retry(): RetryTarget {
    return { call: 'endRound', roundId: this.#roundId };
  }
}

/**
 * Доигрывание активного раунда. Без раунда — стадия замка: authenticate без замка сказал, что раунд есть, и нужен
 * замок, чтобы сверить под ним. С раундом — показ по сверке под замком, дальше endRound.
 */
export class RestoringState implements ClientState {
  readonly view: StateView;
  readonly holdsLock: boolean;
  readonly #round: ShownRound | null;

  constructor(round: ShownRound | null) {
    this.#round = round;
    this.holdsLock = round !== null;
    this.view = round === null ? { name: 'restoring', stage: 'lock', roundId: null } : { name: 'restoring', stage: 'show', roundId: round.roundId };
  }

  on(event: ClientEvent): Transition {
    const round = this.#round;
    switch (event.type) {
      case 'lockGranted':
        return round === null ? to(new AuthenticatingState(true), AUTHENTICATE) : stay(this);
      case 'lockBusy':
        return round === null ? to(new WaitingForTabState(false), QUEUE) : stay(this);
      case 'presented':
        return round === null ? stay(this) : to(new EndingState(round.roundId), { type: 'callEndRound', roundId: round.roundId });
      case 'lockLost':
        return round === null ? stay(this) : displaced();
      case 'start':
      case 'spin':
      case 'retry':
      case 'takeOver':
      case 'authenticated':
      case 'played':
      case 'ended':
      case 'rejected':
      case 'unreachable':
      case 'unusable':
      case 'refill':
      case 'refilled':
        return stay(this);
      default:
        event satisfies never;
        return stay(this);
    }
  }
}

/**
 * Раунд показывает другая вкладка: вкладка стоит в очереди на тот же замок, play не уходит. Хозяин закончит или
 * закроется — очередь отдаст замок сама. «Грати тут» отнимает замок сразу.
 */
export class WaitingForTabState implements ClientState {
  readonly view: StateView;
  readonly holdsLock = false;
  readonly #stealing: boolean;

  constructor(stealing: boolean) {
    this.#stealing = stealing;
    this.view = { name: 'waitingForTab', stealing };
  }

  on(event: ClientEvent): Transition {
    switch (event.type) {
      case 'lockGranted':
        return to(new AuthenticatingState(true), AUTHENTICATE);
      case 'takeOver':
        return this.#stealing ? stay(this) : to(new WaitingForTabState(true), STEAL);
      case 'start':
      case 'spin':
      case 'retry':
      case 'lockBusy':
      case 'lockLost':
      case 'authenticated':
      case 'played':
      case 'presented':
      case 'ended':
      case 'rejected':
      case 'unreachable':
      case 'unusable':
      case 'refill':
      case 'refilled':
        return stay(this);
      default:
        event satisfies never;
        return stay(this);
    }
  }
}

/**
 * «Поповнити»: resetBalance в пути, без замка раунда. Активный раунд есть — сервер ответит ROUND_ACTIVE: сверка, как
 * при запуске, решит, доигрывать его или ждать вкладку, которая его показывает.
 */
export class RefillingState implements ClientState {
  readonly view: StateView = { name: 'refilling' };
  readonly holdsLock = false;

  on(event: ClientEvent): Transition {
    switch (event.type) {
      case 'refilled':
        return to(new IdleState(null));
      case 'rejected':
        return event.code === 'ROUND_ACTIVE' ? to(new AuthenticatingState(false), AUTHENTICATE) : failed(REFILL, false, event);
      case 'unreachable':
      case 'unusable':
        return failed(REFILL, false, event);
      case 'start':
      case 'spin':
      case 'retry':
      case 'takeOver':
      case 'refill':
      case 'lockGranted':
      case 'lockBusy':
      case 'lockLost':
      case 'authenticated':
      case 'played':
      case 'presented':
      case 'ended':
        return stay(this);
      default:
        event satisfies never;
        return stay(this);
    }
  }
}

/**
 * Экран ошибки. retry — запрос для «Повторити»: play с тем же ключом, endRound с тем же roundId; null — лечит только
 * перезагрузка. Замок держится, пока исход запроса не известен: отпусти его — другая вкладка доиграла бы раунд, а
 * повтор с тем же ключом вернул бы уже закрытый.
 */
export class ErrorState implements ClientState {
  readonly view: StateView;
  readonly holdsLock: boolean;
  readonly #retry: RetryTarget | null;

  /** retry play и endRound бывает только под замком: их шлют лишь из состояний, где замок взят. */
  constructor(kind: ErrorKind, retry: RetryTarget | null, holdsLock: boolean) {
    this.#retry = retry;
    this.holdsLock = holdsLock;
    this.view = { name: 'error', kind, retry, holdsLock };
  }

  on(event: ClientEvent): Transition {
    switch (event.type) {
      case 'retry':
        return this.#again();
      case 'lockLost':
        return this.holdsLock ? to(new WaitingForTabState(false), QUEUE) : stay(this);
      case 'start':
      case 'spin':
      case 'takeOver':
      case 'lockGranted':
      case 'lockBusy':
      case 'authenticated':
      case 'played':
      case 'presented':
      case 'ended':
      case 'rejected':
      case 'unreachable':
      case 'unusable':
      case 'refill':
      case 'refilled':
        return stay(this);
      default:
        event satisfies never;
        return stay(this);
    }
  }

  #again(): Transition {
    const retry = this.#retry;
    if (retry === null) return stay(this);
    switch (retry.call) {
      case 'authenticate':
        return to(new AuthenticatingState(this.holdsLock), AUTHENTICATE);
      case 'play':
        return to(new RequestingState('play', retry.key, retry.betMinor), { type: 'callPlay', key: retry.key, betMinor: retry.betMinor });
      case 'endRound':
        return to(new EndingState(retry.roundId), { type: 'callEndRound', roundId: retry.roundId });
      case 'resetBalance':
        return to(new RefillingState(), RESET_BALANCE);
    }
  }
}

/** Начальное состояние клиента. */
export function initialState(): ClientState {
  return new BootingState();
}
