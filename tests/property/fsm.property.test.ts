import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { initialState, type ClientEvent, type Command, type RejectCode, type ShownRound } from '../../src/core/fsm/index.ts';
import { fixtureRound } from '../support/fixture-rounds.ts';

// Машина против модели окружения. Окружение отвечает только тем, что возможно: результат — на запрос в пути,
// замок — на запрос замка, lockLost — когда замок у вкладки; ввод игрока — в любой момент. После каждого шага:
// - play и endRound уходят только под замком, по одному запросу за раз; releaseLock — только держа замок;
// - holdsLock состояния совпадает с моделью: замок не утекает и не мерещится;
// - на свой запрос машина принимает ответ, на свой запрос замка — выдачу: ничего не теряется молча;
// - play уходит с ключом последнего спина; ключ, брошенный при перехвате, не уходит больше никогда.

const ROUNDS: readonly ShownRound[] = [
  { roundId: 'r1', betMinor: 100, winMinor: 35, events: fixtureRound('small-win').events },
  { roundId: 'r2', betMinor: 20, winMinor: 0, events: fixtureRound('loss').events },
];
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

type Call = 'authenticate' | 'play' | 'endRound' | 'resetBalance';

class World {
  held = false;
  lockRequest: 'none' | 'try' | 'queue' | 'steal' = 'none';
  call: Call | null = null;
  presenting = false;
  spinKey: string | null = null;
  readonly burned = new Set<string>();
  readonly violations: string[] = [];
  readonly seen = new Set<string>();
  #keys = 0;

  /** Ввод игрока — возможен всегда. */
  user(): ClientEvent[] {
    this.#keys += 1;
    return [
      { type: 'start' },
      { type: 'spin', key: `k${String(this.#keys)}`, betMinor: 100 },
      { type: 'retry' },
      { type: 'takeOver' },
      { type: 'refill' },
    ];
  }

  /** Ответы окружения, возможные сейчас. */
  environment(pick: number, codePick: number): ClientEvent[] {
    const round = ROUNDS[pick % ROUNDS.length] ?? null;
    // Код отказа — своим числом: от pick зависит и выбор события, и тогда редкие пары (отказ ROUND_ACTIVE на
    // «Поповнити») выпадали бы не в каждом прогоне.
    const code = CODES[codePick % CODES.length] ?? 'INTERNAL';
    const events: ClientEvent[] = [];
    if (this.lockRequest === 'try') events.push({ type: 'lockGranted' }, { type: 'lockBusy' });
    if (this.lockRequest === 'queue' || this.lockRequest === 'steal') events.push({ type: 'lockGranted' });
    if (this.held) events.push({ type: 'lockLost' });
    if (this.presenting) events.push({ type: 'presented' });
    if (this.call !== null) events.push({ type: 'rejected', code }, { type: 'unreachable' }, { type: 'unusable', reason: pick % 2 === 0 ? 'version' : 'invalid' });
    if (this.call === 'authenticate') events.push({ type: 'authenticated', activeRound: pick % 3 === 0 ? null : round });
    if (this.call === 'play' && round !== null) events.push({ type: 'played', round });
    if (this.call === 'endRound') events.push({ type: 'ended' });
    if (this.call === 'resetBalance') events.push({ type: 'refilled' });
    return events;
  }

  /** Событие окружения меняет модель до того, как его увидит машина. */
  deliver(event: ClientEvent): void {
    switch (event.type) {
      case 'lockGranted':
        this.held = true;
        this.lockRequest = 'none';
        break;
      case 'lockBusy':
        this.lockRequest = 'none';
        break;
      case 'lockLost':
        this.held = false;
        break;
      case 'presented':
        this.presenting = false;
        break;
      case 'authenticated':
      case 'played':
      case 'ended':
      case 'refilled':
      case 'rejected':
      case 'unreachable':
      case 'unusable':
        this.call = null;
        break;
      default:
        break;
    }
  }

  /** Ответы окружению обязательны: машина не вправе проигнорировать ответ на свой же запрос. */
  mustAccept(event: ClientEvent, before: { readonly call: Call | null; readonly lock: string; readonly presenting: boolean; readonly held: boolean }): boolean {
    switch (event.type) {
      case 'lockGranted':
      case 'lockBusy':
        return before.lock !== 'none';
      case 'lockLost':
        return before.held;
      case 'presented':
        return before.presenting;
      case 'authenticated':
      case 'played':
      case 'ended':
      case 'refilled':
      case 'rejected':
      case 'unreachable':
      case 'unusable':
        return before.call !== null;
      default:
        return false;
    }
  }

  run(command: Command): void {
    this.seen.add(command.type);
    const busy = (): void => {
      if (this.call !== null) this.violations.push(`${command.type}: запрос ${this.call} ещё в пути`);
    };
    switch (command.type) {
      case 'callAuthenticate':
        busy();
        this.call = 'authenticate';
        break;
      case 'callPlay':
        busy();
        if (!this.held) this.violations.push('play без замка');
        if (command.key !== this.spinKey) this.violations.push(`play с ключом ${command.key}, а спин — ${String(this.spinKey)}`);
        if (this.burned.has(command.key)) this.violations.push(`брошенный ключ ${command.key} ушёл снова`);
        this.call = 'play';
        break;
      case 'callEndRound':
        busy();
        if (!this.held) this.violations.push('endRound без замка');
        this.call = 'endRound';
        break;
      case 'callResetBalance':
        busy();
        this.call = 'resetBalance';
        break;
      case 'takeLock':
      case 'queueForLock':
        if (this.held || this.lockRequest !== 'none') this.violations.push(`${command.type}: замок уже у вкладки или запрошен`);
        this.lockRequest = command.type === 'takeLock' ? 'try' : 'queue';
        break;
      case 'stealLock':
        if (this.held || this.lockRequest !== 'queue') this.violations.push('stealLock не из очереди');
        this.lockRequest = 'steal';
        break;
      case 'releaseLock':
        if (!this.held) this.violations.push('releaseLock без замка');
        this.held = false;
        break;
      case 'abandon':
        this.call = null;
        this.presenting = false;
        break;
      case 'startPresentation':
        busy();
        if (!this.held) this.violations.push('показ без замка');
        this.presenting = true;
        break;
    }
  }
}

describe('FSM против окружения', () => {
  it('замок, запросы и ключи сходятся с моделью на любой последовательности', () => {
    const coverage = new Set<string>();
    // Шаг — ввод игрока (дорожка 0) или ответ окружения (1–3), если он возможен: так прогон доходит до глубоких путей.
    const step = fc.record({ lane: fc.nat(3), pick: fc.nat(1_000), code: fc.nat(CODES.length - 1) });
    fc.assert(
      // size medium: по умолчанию (small) сценарии — около десятка шагов, и глубокие пути выпадают не в каждом прогоне.
      fc.property(fc.array(step, { minLength: 1, maxLength: 150, size: 'medium' }), (script) => {
        const world = new World();
        let state = initialState();
        for (const { lane, pick, code } of script) {
          const environment = world.environment(pick, code);
          const events = lane === 0 || environment.length === 0 ? world.user() : environment;
          const event = events[Math.floor(pick / 8) % events.length];
          if (event === undefined) throw new Error('пустой выбор');
          const before = { call: world.call, lock: world.lockRequest, presenting: world.presenting, held: world.held };
          const view = state.view;
          const pendingKey = view.name === 'requesting' ? view.key : view.name === 'error' && view.retry?.call === 'play' ? view.retry.key : null;
          world.deliver(event);
          const transition = state.on(event);
          if (transition.ignored && world.mustAccept(event, before)) world.violations.push(`${view.name} не принял ${event.type}`);
          if (!transition.ignored && event.type === 'spin') world.spinKey = event.key;
          // Перехват: шаг, начатый до него, брошен — и ключ вместе с ним, даже с экрана ошибки, где запроса в пути нет.
          if (!transition.ignored && event.type === 'lockLost' && pendingKey !== null) world.burned.add(pendingKey);
          for (const command of transition.commands) world.run(command);
          state = transition.state;
          if (state.holdsLock !== world.held) world.violations.push(`${state.view.name}: holdsLock ${String(state.holdsLock)}, модель ${String(world.held)}`);
          coverage.add(`${view.name} → ${state.view.name}`);
          if (world.violations.length > 0) break;
        }
        for (const type of world.seen) coverage.add(type);
        expect(world.violations).toStrictEqual([]);
      }),
      { numRuns: 5000 },
    );
    // Положительный контроль охвата: прогоны дошли до всех команд и до перехвата с доигрыванием.
    for (const reached of [
      'callPlay',
      'callEndRound',
      'callResetBalance',
      'stealLock',
      'abandon',
      'releaseLock',
      'waitingForTab → authenticating',
      'restoring → ending',
      'refilling → idle',
      'refilling → authenticating',
    ]) {
      expect(coverage.has(reached), reached).toBe(true);
    }
  });
});
