import { describe, expect, it } from 'vitest';
import {
  AuthenticatingState,
  BootingState,
  EndingState,
  ErrorState,
  IdleState,
  PresentingState,
  RequestingState,
  RestoringState,
  WaitingForTabState,
  initialState,
  type ClientEvent,
  type ClientState,
  type Command,
  type RejectCode,
  type ShownRound,
  type StateView,
} from '../../../src/core/fsm/index.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';

// Табличный тест FSM (§8.1): каждая пара (состояние, событие). Строка таблицы — допустимый переход: следующее
// состояние снаружи и команды литералами. Пара, которой в таблице нет, обязана вернуть то же состояние с пометкой
// ignored и без команд. Варианты состояний — все формы данных, от которых зависит переход.

const ROUND: ShownRound = { roundId: 'r1', betMinor: 100, winMinor: 35, events: fixtureRound('small-win').events };
const OTHER: ShownRound = { roundId: 'r9', betMinor: 200, winMinor: 210, events: fixtureRound('base-win').events };

const STATES: Readonly<Record<string, () => ClientState>> = {
  booting: () => new BootingState(),
  'authenticating без замка': () => new AuthenticatingState(false),
  'authenticating под замком': () => new AuthenticatingState(true),
  idle: () => new IdleState(null),
  'idle после отказа': () => new IdleState('INSUFFICIENT_FUNDS'),
  'requesting: замок': () => new RequestingState('lock', 'k1', 100),
  'requesting: play': () => new RequestingState('play', 'k1', 100),
  presenting: () => new PresentingState('r1'),
  ending: () => new EndingState('r1'),
  'restoring: замок': () => new RestoringState(null),
  'restoring: показ': () => new RestoringState(ROUND),
  waitingForTab: () => new WaitingForTabState(false),
  'waitingForTab: перехват': () => new WaitingForTabState(true),
  'error: authenticate без замка': () => new ErrorState('unreachable', { call: 'authenticate' }, false),
  'error: authenticate под замком': () => new ErrorState('server', { call: 'authenticate' }, true),
  'error: play': () => new ErrorState('unreachable', { call: 'play', key: 'k1', betMinor: 100 }, true),
  'error: endRound': () => new ErrorState('invalid', { call: 'endRound', roundId: 'r1' }, true),
  'error: перезагрузка': () => new ErrorState('version', null, false),
};

const CODES: readonly RejectCode[] = [
  'INSUFFICIENT_FUNDS',
  'ROUND_ACTIVE',
  'ROUND_NOT_FOUND',
  'INVALID_BET',
  'IDEMPOTENCY_CONFLICT',
  'BAD_REQUEST',
  'VERSION_MISMATCH',
  'INTERNAL',
];

const EVENTS: Readonly<Record<string, ClientEvent>> = {
  start: { type: 'start' },
  spin: { type: 'spin', key: 'k2', betMinor: 200 },
  retry: { type: 'retry' },
  takeOver: { type: 'takeOver' },
  lockGranted: { type: 'lockGranted' },
  lockBusy: { type: 'lockBusy' },
  lockLost: { type: 'lockLost' },
  'authenticated: раунда нет': { type: 'authenticated', activeRound: null },
  'authenticated: раунд': { type: 'authenticated', activeRound: OTHER },
  played: { type: 'played', round: OTHER },
  presented: { type: 'presented' },
  ended: { type: 'ended' },
  ...Object.fromEntries(CODES.map((code) => [`rejected ${code}`, { type: 'rejected', code }])),
  unreachable: { type: 'unreachable' },
  'unusable: version': { type: 'unusable', reason: 'version' },
  'unusable: invalid': { type: 'unusable', reason: 'invalid' },
};

const AUTH: Command = { type: 'callAuthenticate' };
const RELEASE: Command = { type: 'releaseLock' };
const QUEUE: Command = { type: 'queueForLock' };
const ABANDON: Command = { type: 'abandon' };

const IDLE: StateView = { name: 'idle', refusal: null };
const WAITING: StateView = { name: 'waitingForTab', stealing: false };
const AUTH_HELD: StateView = { name: 'authenticating', holdsLock: true };
const RETRY_AUTH = { call: 'authenticate' } as const;
const RETRY_PLAY = { call: 'play', key: 'k1', betMinor: 100 } as const;
const RETRY_END = { call: 'endRound', roundId: 'r1' } as const;
const error = (kind: string, retry: unknown, holdsLock: boolean): StateView => ({ name: 'error', kind, retry, holdsLock }) as StateView;

type Row = readonly [state: string, event: string, next: StateView, commands: readonly Command[]];

/** Коды, которых запрос не ждёт, — ответ не по протоколу: экран ошибки с повтором того же запроса. */
const unexpected = (state: string, codes: readonly RejectCode[], retry: unknown, holdsLock: boolean): Row[] =>
  codes.map((code) => [state, `rejected ${code}`, error('invalid', retry, holdsLock), []]);

const TABLE: readonly Row[] = [
  ['booting', 'start', { name: 'authenticating', holdsLock: false }, [AUTH]],

  // Без замка ответу authenticate не верим: активный раунд — сначала замок.
  ['authenticating без замка', 'authenticated: раунда нет', IDLE, []],
  ['authenticating без замка', 'authenticated: раунд', { name: 'restoring', stage: 'lock', roundId: null }, [{ type: 'takeLock' }]],
  ...unexpected('authenticating без замка', ['INSUFFICIENT_FUNDS', 'ROUND_ACTIVE', 'ROUND_NOT_FOUND', 'INVALID_BET', 'IDEMPOTENCY_CONFLICT'], RETRY_AUTH, false),
  ['authenticating без замка', 'rejected BAD_REQUEST', error('client', null, false), []],
  ['authenticating без замка', 'rejected VERSION_MISMATCH', error('version', null, false), []],
  ['authenticating без замка', 'rejected INTERNAL', error('server', RETRY_AUTH, false), []],
  ['authenticating без замка', 'unreachable', error('unreachable', RETRY_AUTH, false), []],
  ['authenticating без замка', 'unusable: version', error('version', null, false), []],
  ['authenticating без замка', 'unusable: invalid', error('invalid', RETRY_AUTH, false), []],

  // Под замком — доиграть раунд сверки или отпустить замок.
  ['authenticating под замком', 'authenticated: раунда нет', IDLE, [RELEASE]],
  ['authenticating под замком', 'authenticated: раунд', { name: 'restoring', stage: 'show', roundId: 'r9' }, [
    { type: 'startPresentation', round: OTHER, restored: true },
  ]],
  ...unexpected('authenticating под замком', ['INSUFFICIENT_FUNDS', 'ROUND_ACTIVE', 'ROUND_NOT_FOUND', 'INVALID_BET', 'IDEMPOTENCY_CONFLICT'], RETRY_AUTH, true),
  ['authenticating под замком', 'rejected BAD_REQUEST', error('client', null, false), [RELEASE]],
  ['authenticating под замком', 'rejected VERSION_MISMATCH', error('version', null, false), [RELEASE]],
  ['authenticating под замком', 'rejected INTERNAL', error('server', RETRY_AUTH, true), []],
  ['authenticating под замком', 'unreachable', error('unreachable', RETRY_AUTH, true), []],
  ['authenticating под замком', 'unusable: version', error('version', null, false), [RELEASE]],
  ['authenticating под замком', 'unusable: invalid', error('invalid', RETRY_AUTH, true), []],
  ['authenticating под замком', 'lockLost', WAITING, [ABANDON, QUEUE]],

  ['idle', 'spin', { name: 'requesting', stage: 'lock', key: 'k2', betMinor: 200 }, [{ type: 'takeLock' }]],
  ['idle после отказа', 'spin', { name: 'requesting', stage: 'lock', key: 'k2', betMinor: 200 }, [{ type: 'takeLock' }]],

  // Замок занят — play не уходит.
  ['requesting: замок', 'lockGranted', { name: 'requesting', stage: 'play', key: 'k1', betMinor: 100 }, [
    { type: 'callPlay', key: 'k1', betMinor: 100 },
  ]],
  ['requesting: замок', 'lockBusy', WAITING, [QUEUE]],

  ['requesting: play', 'played', { name: 'presenting', roundId: 'r9' }, [{ type: 'startPresentation', round: OTHER, restored: false }]],
  ['requesting: play', 'rejected ROUND_ACTIVE', AUTH_HELD, [AUTH]],
  ['requesting: play', 'rejected INSUFFICIENT_FUNDS', { name: 'idle', refusal: 'INSUFFICIENT_FUNDS' }, [RELEASE]],
  ['requesting: play', 'rejected INVALID_BET', { name: 'idle', refusal: 'INVALID_BET' }, [RELEASE]],
  ['requesting: play', 'rejected IDEMPOTENCY_CONFLICT', { name: 'idle', refusal: 'IDEMPOTENCY_CONFLICT' }, [RELEASE]],
  ['requesting: play', 'rejected ROUND_NOT_FOUND', { name: 'idle', refusal: 'ROUND_NOT_FOUND' }, [RELEASE]],
  ['requesting: play', 'rejected BAD_REQUEST', error('client', null, false), [RELEASE]],
  ['requesting: play', 'rejected VERSION_MISMATCH', error('version', null, false), [RELEASE]],
  ['requesting: play', 'rejected INTERNAL', error('server', RETRY_PLAY, true), []],
  ['requesting: play', 'unreachable', error('unreachable', RETRY_PLAY, true), []],
  ['requesting: play', 'unusable: version', error('version', null, false), [RELEASE]],
  ['requesting: play', 'unusable: invalid', error('invalid', RETRY_PLAY, true), []],
  ['requesting: play', 'lockLost', WAITING, [ABANDON, QUEUE]],

  ['presenting', 'presented', { name: 'ending', roundId: 'r1' }, [{ type: 'callEndRound', roundId: 'r1' }]],
  ['presenting', 'lockLost', WAITING, [ABANDON, QUEUE]],

  ['ending', 'ended', IDLE, [RELEASE]],
  ['ending', 'rejected ROUND_NOT_FOUND', AUTH_HELD, [AUTH]],
  ...unexpected('ending', ['INSUFFICIENT_FUNDS', 'ROUND_ACTIVE', 'INVALID_BET', 'IDEMPOTENCY_CONFLICT'], RETRY_END, true),
  ['ending', 'rejected BAD_REQUEST', error('client', null, false), [RELEASE]],
  ['ending', 'rejected VERSION_MISMATCH', error('version', null, false), [RELEASE]],
  ['ending', 'rejected INTERNAL', error('server', RETRY_END, true), []],
  ['ending', 'unreachable', error('unreachable', RETRY_END, true), []],
  ['ending', 'unusable: version', error('version', null, false), [RELEASE]],
  ['ending', 'unusable: invalid', error('invalid', RETRY_END, true), []],
  ['ending', 'lockLost', WAITING, [ABANDON, QUEUE]],

  ['restoring: замок', 'lockGranted', AUTH_HELD, [AUTH]],
  ['restoring: замок', 'lockBusy', WAITING, [QUEUE]],
  ['restoring: показ', 'presented', { name: 'ending', roundId: 'r1' }, [{ type: 'callEndRound', roundId: 'r1' }]],
  ['restoring: показ', 'lockLost', WAITING, [ABANDON, QUEUE]],

  ['waitingForTab', 'lockGranted', AUTH_HELD, [AUTH]],
  ['waitingForTab', 'takeOver', { name: 'waitingForTab', stealing: true }, [{ type: 'stealLock' }]],
  ['waitingForTab: перехват', 'lockGranted', AUTH_HELD, [AUTH]],

  ['error: authenticate без замка', 'retry', { name: 'authenticating', holdsLock: false }, [AUTH]],
  ['error: authenticate под замком', 'retry', AUTH_HELD, [AUTH]],
  ['error: authenticate под замком', 'lockLost', WAITING, [QUEUE]],
  // Повтор — тот же ключ и та же ставка.
  ['error: play', 'retry', { name: 'requesting', stage: 'play', key: 'k1', betMinor: 100 }, [{ type: 'callPlay', key: 'k1', betMinor: 100 }]],
  ['error: play', 'lockLost', WAITING, [QUEUE]],
  ['error: endRound', 'retry', { name: 'ending', roundId: 'r1' }, [{ type: 'callEndRound', roundId: 'r1' }]],
  ['error: endRound', 'lockLost', WAITING, [QUEUE]],
];

const EXPECTED = new Map(TABLE.map(([state, event, next, commands]) => [`${state} × ${event}`, { next, commands }] as const));
const PAIRS = Object.keys(STATES).flatMap((state) => Object.keys(EVENTS).map((event) => [state, event] as const));

describe('таблица переходов', () => {
  it('строки таблицы — только существующие пары, без повторов', () => {
    expect(EXPECTED.size).toBe(TABLE.length);
    const known = new Set(PAIRS.map(([state, event]) => `${state} × ${event}`));
    expect(TABLE.filter(([state, event]) => !known.has(`${state} × ${event}`))).toStrictEqual([]);
  });

  it(`покрыто ${String(Object.keys(STATES).length)} × ${String(Object.keys(EVENTS).length)} пар`, () => {
    expect(PAIRS.length).toBe(18 * 23);
  });

  it.each(PAIRS)('%s × %s', (stateName, eventName) => {
    const state = STATES[stateName]?.();
    const event = EVENTS[eventName];
    if (state === undefined || event === undefined) throw new Error('нет в таблице');
    const expected = EXPECTED.get(`${stateName} × ${eventName}`);
    const transition = state.on(event);
    if (expected === undefined) {
      expect(transition.ignored).toBe(true);
      expect(transition.state).toBe(state);
      expect(transition.commands).toStrictEqual([]);
      return;
    }
    expect(transition.ignored).toBe(false);
    expect(transition.state.view).toStrictEqual(expected.next);
    expect(transition.commands).toStrictEqual(expected.commands);
  });
});

describe('состояния', () => {
  it('начальное — booting', () => {
    expect(initialState().view).toStrictEqual({ name: 'booting' });
  });

  it.each([
    ['booting', false],
    ['authenticating без замка', false],
    ['authenticating под замком', true],
    ['idle', false],
    ['idle после отказа', false],
    ['requesting: замок', false],
    ['requesting: play', true],
    ['presenting', true],
    ['ending', true],
    ['restoring: замок', false],
    ['restoring: показ', true],
    ['waitingForTab', false],
    ['waitingForTab: перехват', false],
    ['error: authenticate без замка', false],
    ['error: authenticate под замком', true],
    ['error: play', true],
    ['error: endRound', true],
    ['error: перезагрузка', false],
  ] as const)('%s: замок у вкладки — %s', (stateName, holds) => {
    expect(STATES[stateName]?.().holdsLock).toBe(holds);
  });

  it('событие вне объединения не бросает и не принимается ни одним состоянием', () => {
    const stray = { type: 'teapot' } as unknown as ClientEvent;
    for (const make of Object.values(STATES)) {
      const state = make();
      const transition = state.on(stray);
      expect([transition.state === state, transition.ignored, transition.commands]).toStrictEqual([true, true, []]);
    }
  });
});
