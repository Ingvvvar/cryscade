import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GameController,
  MemoryRoundLock,
  PRESETS,
  Presenter,
  type CheckpointStore,
  type CallOutcome,
  type Rgs,
  type RoundLease,
  type RoundLock,
  type Transport,
} from '../../../src/client/index.ts';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import type { RequestBody, Results } from '../../../src/protocol/index.ts';
import {
  MemoryStorage,
  StorageError,
  type CommitBatch,
  type CommitOutcome,
  type Storage,
  type StoreKey,
  type StoreName,
} from '../../../src/server/index.ts';
import { ClientWorld, type Tab, type WorkerPort } from '../../support/client-world.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';
import { plant } from '../../support/rgs-rig.ts';
import { verifyRound } from '../../support/round-model.ts';
import { ScriptedBookLoader, testBook } from '../../support/test-book.ts';

// GameController на поддельных портах (§6.5, §8.1): вкладки — контроллеры над настоящим RgsServer на общем
// хранилище в памяти, замок раунда — MemoryRoundLock с семантикой Web Locks, канал — с доставкой позже прямого
// ответа, время — поддельные таймеры. Сид сервера по умолчанию 0: small-win, ставка 100 → выигрыш 95.
// Балансы — литералы: 100 000 − 100 = 99 900 после ставки, + 95 = 99 995 после зачисления.

const SMALL = fixtureRound('small-win');
const DEMO = fixtureRound('feature-start').events[0];
const DEMO_GRID = DEMO?.t === 'fill' ? DEMO.grid : [];
const SMALL_GRID = verifyRound(DEFAULT_CONFIG, SMALL.events).finalGrid;
const LEVELS = [20, 40, 100, 200, 400, 1000, 2000, 5000, 10000];
const IDLE = { name: 'idle', refusal: null };
const WAITING = { name: 'waitingForTab', stealing: false };

/** Дать отработать микрозадачам и таймерам канала. */
async function settle(ms = 10): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Баланс по пути: подряд идущие одинаковые значения схлопнуты. */
function balancePath(tab: Tab): (number | null)[] {
  const path: (number | null)[] = [];
  for (const snapshot of tab.snapshots) if (path.at(-1) !== snapshot.balanceMinor) path.push(snapshot.balanceMinor);
  return path;
}

function plays(tab: Tab): unknown[] {
  return tab.port.received.filter((body) => body.type === 'play');
}

function roundsIn(world: ClientWorld): unknown[] {
  return world.storage.snapshot().rounds.map(([, round]) => {
    const { roundId, status, idempotencyKey } = round as { roundId: string; status: string; idempotencyKey: string };
    return { roundId, status, idempotencyKey };
  });
}

/** Хранилище, у которого первые commit падают: INTERNAL на сервере. */
class FailingCommits implements Storage {
  readonly durable = true;
  readonly #inner: Storage;
  #failures: number;

  constructor(inner: Storage, failures: number) {
    this.#inner = inner;
    this.#failures = failures;
  }

  get(store: StoreName, key: StoreKey): Promise<unknown> {
    return this.#inner.get(store, key);
  }

  keysByIndex(...args: Parameters<Storage['keysByIndex']>): ReturnType<Storage['keysByIndex']> {
    return this.#inner.keysByIndex(...args);
  }

  lastByIndex(...args: Parameters<Storage['lastByIndex']>): ReturnType<Storage['lastByIndex']> {
    return this.#inner.lastByIndex(...args);
  }

  descend(...args: Parameters<Storage['descend']>): ReturnType<Storage['descend']> {
    return this.#inner.descend(...args);
  }

  commit(batch: CommitBatch): Promise<CommitOutcome> {
    if (this.#failures === 0) return this.#inner.commit(batch);
    this.#failures -= 1;
    return Promise.reject(new StorageError('квота исчерпана'));
  }
}

/** Воркер, которому тест подменяет следующий ответ. */
class TamperedPort implements Transport {
  tamper: ((response: Record<string, unknown>) => unknown) | null = null;
  readonly #inner: WorkerPort;

  constructor(inner: WorkerPort) {
    this.#inner = inner;
  }

  send(message: unknown): void {
    this.#inner.send(message);
  }

  listen(listener: (message: unknown) => void): () => void {
    return this.#inner.listen((message) => {
      const tamper = this.tamper;
      this.tamper = null;
      listener(tamper === null ? message : tamper(message as Record<string, unknown>));
    });
  }
}

/** Воркер, чьи ответы стоят, пока тест их не отпустит. */
class HeldPort implements Transport {
  readonly #inner: WorkerPort;
  readonly #held: (() => void)[] = [];
  holding = true;

  constructor(inner: WorkerPort) {
    this.#inner = inner;
  }

  send(message: unknown): void {
    this.#inner.send(message);
  }

  listen(listener: (message: unknown) => void): () => void {
    return this.#inner.listen((message) => {
      if (this.holding) {
        this.#held.push(() => {
          listener(message);
        });
      } else {
        listener(message);
      }
    });
  }

  release(): void {
    this.holding = false;
    for (const deliver of this.#held.splice(0)) deliver();
  }
}

/** Замок, чья проба ifAvailable ждёт, пока тест не откроет ворота. */
class GatedLock implements RoundLock {
  readonly #inner: RoundLock;
  #open: () => void = () => undefined;
  readonly #gate = new Promise<void>((resolve) => {
    this.#open = resolve;
  });

  constructor(inner: RoundLock) {
    this.#inner = inner;
  }

  open(): void {
    this.#open();
  }

  async tryAcquire(): Promise<RoundLease | null> {
    await this.#gate;
    return this.#inner.tryAcquire();
  }

  acquire(signal: AbortSignal): Promise<RoundLease> {
    return this.#inner.acquire(signal);
  }

  steal(): Promise<RoundLease> {
    return this.#inner.steal();
  }
}

/** RGS теста: каждый вызов ждёт, пока тест его не разрешит. */
class ManualRgs implements Rgs {
  readonly calls: { readonly body: RequestBody; readonly signal: AbortSignal | undefined; readonly resolve: (outcome: CallOutcome<unknown>) => void }[] = [];

  call<B extends RequestBody>(body: B, signal?: AbortSignal): Promise<CallOutcome<Results[B['type']]>> {
    return new Promise((resolve) => {
      this.calls.push({ body, signal, resolve: resolve as (outcome: CallOutcome<unknown>) => void });
    });
  }

  answer(index: number, result: unknown): void {
    const call = this.calls[index];
    if (call === undefined) throw new Error(`вызова ${String(index)} нет`);
    call.resolve({ kind: 'ok', result });
  }
}

/** Замок, чью очередь тест выдаёт рукой — в нужный ему миг. */
class HandLock implements RoundLock {
  readonly inner = new MemoryRoundLock();
  steals = 0;
  #grant: ((lease: RoundLease) => void) | null = null;

  tryAcquire(): Promise<RoundLease | null> {
    return this.inner.tryAcquire();
  }

  acquire(signal: AbortSignal): Promise<RoundLease> {
    return new Promise((resolve, reject) => {
      this.#grant = resolve;
      signal.addEventListener('abort', () => {
        reject(new DOMException('запрос замка снят', 'AbortError'));
      });
    });
  }

  steal(): Promise<RoundLease> {
    this.steals += 1;
    return this.inner.steal();
  }

  grantQueued(lease: RoundLease): void {
    this.#grant?.(lease);
  }
}

const QUIET = { listen: () => () => undefined };
const NO_SHOW = { listen: () => undefined, play: () => undefined, rest: () => undefined, skip: () => undefined, resume: () => undefined, halt: () => undefined };
const AUTH_RESULT = {
  balanceMinor: 100_000,
  config: { betLevelsMinor: [100], capX100: 500_000 },
  activeRound: null,
  idleGrid: DEMO_GRID,
  notice: null,
  wallet: { balanceMinor: 100_000, revision: 0, notice: null },
  fairness: null,
};
const PLAY_RESULT = {
  round: { roundId: 'r1', betMinor: 100, payX100: 95, winMinor: 95, events: SMALL.events, source: 'live', bookIndex: null, nonce: null },
  balanceMinor: 99_900,
  wallet: { balanceMinor: 99_900, revision: 1, notice: null },
};

function manualController(rgs: Rgs, roundLock: RoundLock): GameController {
  return new GameController({ rgs, roundLock, localLock: new MemoryRoundLock(), channel: QUIET, notices: QUIET, keys: { next: () => 'k1' }, presentation: NO_SHOW });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('запуск и спин', () => {
  it('запуск: authenticate — баланс, ставка по умолчанию 1 кредит, уровни, заставка; замок не взят', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    expect(a.state).toStrictEqual({ name: 'authenticating', holdsLock: false });
    await settle();
    expect(a.snapshot).toStrictEqual({
      state: IDLE,
      balanceMinor: 100_000,
      betMinor: 100,
      betLevelsMinor: LEVELS,
      grid: DEMO_GRID,
      winMinor: null,
      notice: null,
      mode: 'play',
    });
    expect(a.calls).toStrictEqual(['authenticate']);
    expect(await world.lockFree()).toBe(true);
  });

  it('спин: замок, play, мгновенный показ, endRound, замок отпущен; баланс не мигает назад от своих поздних оповещений', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.controller.spin();
    expect(a.state).toStrictEqual({ name: 'requesting', stage: 'lock', key: 'ak1', betMinor: 100 });
    await settle();
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995, winMinor: 95, grid: SMALL_GRID });
    expect(a.port.received).toStrictEqual([
      { type: 'authenticate' },
      { type: 'play', betMinor: 100, idempotencyKey: 'ak1' },
      { type: 'endRound', roundId: 'ar1' },
    ]);
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar1', status: 'closed', idempotencyKey: 'ak1' }]);
    expect(await world.lockFree()).toBe(true);
    // Свои оповещения (ревизии 1 и 2) пришли после ответа на endRound — и не откатили баланс к 99 900.
    expect(world.bus.sent.map((message) => message.revision)).toStrictEqual([1, 2]);
    expect(balancePath(a)).toStrictEqual([null, 100_000, 99_900, 99_995]);
    expect(a.snapshots.map((snapshot) => snapshot.state.name)).toStrictEqual(['authenticating', 'idle', 'requesting', 'requesting', 'ending', 'idle']);
  });

  it('книга исходов: prefetchBook шлёт loadBook один раз за жизнь контроллера, и не после dispose', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.controller.prefetchBook();
    a.controller.prefetchBook();
    await settle();
    expect(a.port.received.filter((body) => body.type === 'loadBook')).toHaveLength(1);
    const b = world.open('b');
    await settle();
    b.controller.dispose();
    b.controller.prefetchBook();
    await settle();
    expect(b.port.received.filter((body) => body.type === 'loadBook')).toHaveLength(0);
  });

  it('ставка ±: по уровням, упирается в края, меняется только в idle; спин идёт с выбранной', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    a.controller.betUp();
    expect(a.snapshot.betMinor).toBeNull();
    await settle();
    a.controller.betUp();
    expect(a.snapshot.betMinor).toBe(200);
    for (let step = 0; step < 10; step++) a.controller.betDown();
    expect(a.snapshot.betMinor).toBe(20);
    for (let step = 0; step < 10; step++) a.controller.betUp();
    expect(a.snapshot.betMinor).toBe(10_000);
    a.controller.betDown();
    a.controller.spin();
    a.controller.betDown();
    expect(a.snapshot.betMinor).toBe(5000);
    await settle();
    expect(plays(a)).toStrictEqual([{ type: 'play', betMinor: 5000, idempotencyKey: 'ak1' }]);
  });

  it('мало средств — спин не состоялся: idle с отказом, замок отпущен, раунда нет', async () => {
    const world = new ClientWorld();
    await plant(world.storage, [
      { op: 'put', store: 'wallet', value: { id: 'main', balanceMinor: 50, activeRoundId: null, nextSeq: 1, revision: 3, resetSeq: 1 } },
    ]);
    const a = world.open('a');
    await settle();
    a.controller.spin();
    await settle();
    expect(a.snapshot).toMatchObject({ state: { name: 'idle', refusal: 'INSUFFICIENT_FUNDS' }, balanceMinor: 50 });
    expect(roundsIn(world)).toStrictEqual([]);
    expect(await world.lockFree()).toBe(true);
  });

  it('«Поповнити» после отказа: resetBalance без замка раунда, баланс 1000, спин проходит', async () => {
    const world = new ClientWorld();
    await plant(world.storage, [
      { op: 'put', store: 'wallet', value: { id: 'main', balanceMinor: 50, activeRoundId: null, nextSeq: 1, revision: 3, resetSeq: 1 } },
    ]);
    const a = world.open('a');
    await settle();
    a.controller.spin();
    await settle();
    a.controller.refill();
    expect(a.state).toStrictEqual({ name: 'refilling' });
    expect(await world.lockFree()).toBe(true);
    await settle();
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 100_000 });
    a.controller.spin();
    await settle();
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995 });
    expect(a.calls).toStrictEqual(['authenticate', 'play', 'resetBalance', 'play', 'endRound']);
  });

  it('«Поповнити», пока другая вкладка показывает раунд: ROUND_ACTIVE — сверка, вкладка ждёт хозяина, баланс не тронут', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    const b = world.open('b');
    await settle();
    a.lab.holdNextEndRound();
    a.controller.spin();
    await settle();
    expect(a.state).toStrictEqual({ name: 'ending', roundId: 'ar1' });
    b.controller.refill();
    await settle();
    expect(b.state).toStrictEqual(WAITING);
    expect(b.calls).toStrictEqual(['authenticate', 'resetBalance', 'authenticate']);
    expect(world.storage.snapshot().wallet[0]?.[1]).toMatchObject({ balanceMinor: 99_900, activeRoundId: 'ar1' });
    a.lab.releaseHeld();
    await settle();
    expect([a.state, b.state]).toStrictEqual([IDLE, IDLE]);
  });

  it('«Поповнити» без связи — экран ошибки с повтором resetBalance; «Повторити» доходит', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.lab.set({ requestLoss: 1 });
    a.controller.refill();
    await settle(20_000);
    expect(a.state).toStrictEqual({ name: 'error', kind: 'unreachable', retry: { call: 'resetBalance' }, holdsLock: false });
    a.lab.set({ requestLoss: 0 });
    a.controller.retry();
    await settle();
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 100_000 });
    expect(a.calls).toStrictEqual(['authenticate', 'resetBalance']);
  });

  it('снимок — тот же объект, пока ничего не изменилось; подписка снимается', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    const before = a.controller.getSnapshot();
    let calls = 0;
    const off = a.controller.subscribe(() => {
      calls += 1;
    });
    a.controller.retry();
    a.controller.takeOver();
    await settle();
    expect([a.controller.getSnapshot() === before, calls]).toStrictEqual([true, 0]);
    off();
    a.controller.spin();
    await settle();
    expect(calls).toBe(0);
    expect(a.controller.getSnapshot()).not.toBe(before);
  });
});

describe('повторы и экран ошибки', () => {
  it('потерян ответ на play — повтор с тем же ключом через 3 с + 250 мс: тот же раунд, одно списание', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.lab.loseNextResponse();
    a.controller.spin();
    await settle(3000);
    expect(a.state).toStrictEqual({ name: 'requesting', stage: 'play', key: 'ak1', betMinor: 100 });
    await settle(300);
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995 });
    expect(plays(a)).toStrictEqual([
      { type: 'play', betMinor: 100, idempotencyKey: 'ak1' },
      { type: 'play', betMinor: 100, idempotencyKey: 'ak1' },
    ]);
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar1', status: 'closed', idempotencyKey: 'ak1' }]);
    expect(a.client.pendingAttempts).toBe(0);
  });

  it('первая попытка шла дольше таймаута и пришла после повтора: раунд один, её ответ брошен, второго списания нет', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.lab.set({ latencyMs: 3500 });
    a.controller.spin();
    await settle();
    a.lab.set({ latencyMs: 0 });
    await settle(20_000);
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995, winMinor: 95 });
    // Повтор (3250 мс) дошёл раньше оригинала (3500 мс): раунд записал повтор, оригинал получил его же, уже закрытым.
    expect(a.calls).toStrictEqual(['authenticate', 'play', 'endRound', 'play']);
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar1', status: 'closed', idempotencyKey: 'ak1' }]);
    expect(world.bus.sent.map((message) => message.balanceMinor)).toStrictEqual([99_900, 99_995]);
    expect(balancePath(a)).toStrictEqual([null, 100_000, 99_900, 99_995]);
    expect(a.client.pendingAttempts).toBe(0);
  });

  it('повторы кончились — экран ошибки, замок держится; «Повторити» — тот же ключ', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.lab.set({ requestLoss: 1 });
    a.controller.spin();
    await settle(18_740);
    expect(a.state.name).toBe('requesting');
    await settle(20);
    expect(a.state).toStrictEqual({ name: 'error', kind: 'unreachable', retry: { call: 'play', key: 'ak1', betMinor: 100 }, holdsLock: true });
    expect(await world.lockFree()).toBe(false);
    expect(plays(a)).toStrictEqual([]);
    // Пять потерянных попыток — ни одной в памяти.
    expect(a.client.pendingAttempts).toBe(0);
    a.lab.set({ requestLoss: 0 });
    a.controller.retry();
    await settle();
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995 });
    expect(plays(a)).toStrictEqual([{ type: 'play', betMinor: 100, idempotencyKey: 'ak1' }]);
    expect(await world.lockFree()).toBe(true);
  });

  it('раунд записан, но все ответы потеряны: «Повторити» получает тот же раунд, второго списания нет', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.lab.set({ responseLoss: 1 });
    a.controller.spin();
    await settle(18_760);
    expect(a.state.name).toBe('error');
    a.lab.set({ responseLoss: 0 });
    a.controller.retry();
    await settle();
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995, winMinor: 95 });
    expect(plays(a)).toHaveLength(6);
    expect(new Set(plays(a).map((body) => JSON.stringify(body)))).toStrictEqual(new Set([JSON.stringify({ type: 'play', betMinor: 100, idempotencyKey: 'ak1' })]));
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar1', status: 'closed', idempotencyKey: 'ak1' }]);
  });

  it('INTERNAL — экран ошибки без автоповтора; «Повторити» — тот же ключ', async () => {
    const world = new ClientWorld();
    const a = world.open('a', { wrapStorage: (inner) => new FailingCommits(inner, 1) });
    await settle();
    a.controller.spin();
    await settle(20_000);
    expect(a.state).toStrictEqual({ name: 'error', kind: 'server', retry: { call: 'play', key: 'ak1', betMinor: 100 }, holdsLock: true });
    expect(a.calls).toStrictEqual(['authenticate', 'play']);
    a.controller.retry();
    await settle();
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995 });
    // id ar1 сгорел на упавшей записи: сервер берёт его до транзакции.
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar2', status: 'closed', idempotencyKey: 'ak1' }]);
  });

  it('ответ не прошёл гард — экран ошибки с повтором; повтор получает записанный раунд', async () => {
    const world = new ClientWorld();
    let port: TamperedPort | null = null;
    const a = world.open('a', {
      wrapPort: (inner) => {
        port = new TamperedPort(inner);
        return port;
      },
    });
    await settle();
    const tampered = port as TamperedPort | null;
    if (tampered === null) throw new Error('нет воркера');
    tampered.tamper = (response) => ({ ...response, body: { ok: true, result: { round: 'испорчено' } } });
    a.controller.spin();
    await settle();
    expect(a.state).toStrictEqual({ name: 'error', kind: 'invalid', retry: { call: 'play', key: 'ak1', betMinor: 100 }, holdsLock: true });
    a.controller.retry();
    await settle();
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995 });
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar1', status: 'closed', idempotencyKey: 'ak1' }]);
  });

  it('сервер другой версии — экран перезагрузки: замок отпущен, «Повторити» ничего не шлёт', async () => {
    const world = new ClientWorld();
    let port: TamperedPort | null = null;
    const a = world.open('a', {
      wrapPort: (inner) => {
        port = new TamperedPort(inner);
        return port;
      },
    });
    await settle();
    const tampered = port as TamperedPort | null;
    if (tampered === null) throw new Error('нет воркера');
    tampered.tamper = (response) => ({ ...response, v: 2 });
    a.controller.spin();
    await settle();
    expect(a.state).toStrictEqual({ name: 'error', kind: 'version', retry: null, holdsLock: false });
    expect(await world.lockFree()).toBe(true);
    a.controller.retry();
    await settle(20_000);
    expect(a.calls).toStrictEqual(['authenticate', 'play']);
  });

  it('вызов RGS упал — экран ошибки с повтором, а не вечное ожидание', async () => {
    const rgs: Rgs = { call: () => Promise.reject(new Error('сбой')) };
    const lock = new MemoryRoundLock();
    const controller = new GameController({
      rgs,
      roundLock: lock,
      localLock: new MemoryRoundLock(),
      channel: { listen: () => () => undefined },
      notices: { listen: () => () => undefined },
      keys: { next: () => 'k' },
      presentation: NO_SHOW,
    });
    controller.start();
    await settle();
    expect(controller.getSnapshot().state).toStrictEqual({ name: 'error', kind: 'unreachable', retry: { call: 'authenticate' }, holdsLock: false });
  });
});

describe('показ на сцене', () => {
  it('сетка покоя — при authenticate, каждый раунд — при старте показа, по порядку', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    expect(a.presentation.log).toStrictEqual([]);
    await settle();
    expect(a.presentation.log).toStrictEqual([{ rest: DEMO_GRID }]);
    a.controller.spin();
    await settle();
    a.controller.spin();
    await settle();
    expect(a.presentation.log).toStrictEqual([{ rest: DEMO_GRID }, { play: 'ar1' }, { play: 'ar2' }]);
  });

  it('восстановление: сетка до раунда, потом его показ; сверка под замком ту же сетку заново не роняет', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.lab.reloadMidNextRound();
    a.controller.spin();
    await settle();
    a.close();
    const reloaded = world.open('a2');
    await settle();
    expect(reloaded.port.received.filter((body) => body.type === 'authenticate')).toHaveLength(2);
    expect(reloaded.presentation.log).toStrictEqual([{ rest: DEMO_GRID }, { restore: 'ar1' }]);
  });

  it('ROUND_ACTIVE на спин: та же сетка покоя заново не роняется — сразу показ чужого раунда', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.controller.spin();
    await settle();
    const b = world.open('b');
    await settle();
    b.lab.reloadMidNextRound();
    b.controller.spin();
    await settle();
    b.close();
    a.controller.spin();
    await settle();
    expect(a.calls.filter((call) => call === 'authenticate')).toHaveLength(2);
    expect(a.presentation.log).toStrictEqual([{ rest: DEMO_GRID }, { play: 'ar1' }, { restore: 'br1' }]);
  });

  it('ждёт вкладку: на поле — сетка до чужого раунда; раунд доигран — его итоговая сетка', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.lab.reloadMidNextRound();
    a.controller.spin();
    await settle();
    a.close();
    const b = world.open('b');
    b.lab.holdNextEndRound();
    await settle();
    const c = world.open('c');
    await settle();
    expect(c.state).toStrictEqual(WAITING);
    expect(c.presentation.log).toStrictEqual([{ rest: DEMO_GRID }]);
    b.lab.releaseHeld();
    await settle();
    expect(c.state).toStrictEqual(IDLE);
    expect(c.presentation.log).toStrictEqual([{ rest: DEMO_GRID }, { rest: SMALL_GRID }]);
  });
});

/** Часы показа, которые тест двигает сам; контрольная точка — в памяти. */
function clockShow(skip = true): Presenter {
  const checkpoints: CheckpointStore = { read: () => null, write: () => undefined };
  return new Presenter({ options: () => ({ speed: 'normal', preset: PRESETS.standard, reducedMotion: false }), skip }, checkpoints);
}

describe('показ по часам', () => {
  it('endRound — когда показ дошёл до конца; до ответа на панели баланс после ставки', async () => {
    const world = new ClientWorld();
    const show = clockShow();
    const a = world.open('a', { presentation: show });
    await settle();
    a.controller.spin();
    await settle();
    expect(a.state).toStrictEqual({ name: 'presenting', roundId: 'ar1' });
    const duration = show.schedule?.durationMs ?? 0;
    show.tick(duration - 1);
    await settle();
    expect(a.state.name).toBe('presenting');
    expect(a.calls).toStrictEqual(['authenticate', 'play']);
    expect(a.snapshot.balanceMinor).toBe(99_900);
    show.tick(1);
    await settle();
    expect(a.calls).toStrictEqual(['authenticate', 'play', 'endRound']);
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995 });
  });

  it('фича: часы встают на плашке — featureIntro; тап — показ дальше, endRound после конца', async () => {
    const world = new ClientWorld();
    const show = clockShow();
    const a = world.open('a', { presentation: show, seeds: [48] });
    await settle();
    a.controller.spin();
    await settle();
    show.tick(Number.MAX_SAFE_INTEGER);
    await settle();
    expect(a.state).toStrictEqual({ name: 'featureIntro', roundId: 'ar1' });
    show.tick(60_000);
    await settle();
    expect(a.calls).toStrictEqual(['authenticate', 'play']);
    a.controller.tap();
    expect(a.state).toStrictEqual({ name: 'presenting', roundId: 'ar1' });
    show.tick(Number.MAX_SAFE_INTEGER);
    await settle();
    expect(a.calls).toStrictEqual(['authenticate', 'play', 'endRound']);
    expect(a.state).toStrictEqual(IDLE);
  });

  it('пропуск: первый тап — к концу группы, второй — к концу раунда, и endRound уходит сразу', async () => {
    const world = new ClientWorld();
    const show = clockShow();
    const a = world.open('a', { presentation: show, seeds: [12387] });
    await settle();
    a.controller.spin();
    await settle();
    const groups = show.schedule?.groups ?? [];
    show.tick(10);
    a.controller.tap();
    expect(show.clock).toBe(groups[0]?.endMs);
    expect(a.state.name).toBe('presenting');
    a.controller.tap();
    expect(show.clock).toBe(show.schedule?.durationMs);
    expect(a.state).toStrictEqual({ name: 'ending', roundId: 'ar1' });
    await settle();
    expect(a.state).toStrictEqual(IDLE);
  });

  it('строгий пресет: тап показ не пропускает', async () => {
    const world = new ClientWorld();
    const show = clockShow(false);
    const a = world.open('a', { presentation: show });
    await settle();
    a.controller.spin();
    await settle();
    show.tick(10);
    a.controller.tap();
    a.controller.tap();
    expect(show.clock).toBe(10);
    expect(a.state.name).toBe('presenting');
  });

  it('замок отняли посреди показа — показ брошен: часы стоят, endRound не уходит', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    const show = clockShow();
    const b = world.open('b', { presentation: show });
    await settle();
    b.controller.spin();
    await settle();
    show.tick(100);
    a.controller.spin();
    await settle();
    a.controller.takeOver();
    await settle();
    // a отняла замок и доиграла раунд b; b брошенный показ не продолжает, сверилась и вернулась в покой.
    show.tick(Number.MAX_SAFE_INTEGER);
    await settle();
    expect(show.clock).toBe(100);
    expect(b.calls).toStrictEqual(['authenticate', 'play', 'authenticate']);
    expect(a.calls).toStrictEqual(['authenticate', 'authenticate', 'endRound']);
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'br1', status: 'closed', idempotencyKey: 'bk1' }]);
    expect([a.state, b.state]).toStrictEqual([IDLE, IDLE]);
  });
});

describe('восстановление', () => {
  it('перезагрузка посреди раунда: authenticate, замок, сверка под замком, доигрывание и endRound', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.lab.reloadMidNextRound();
    a.controller.spin();
    await settle();
    expect(a.reloads).toBe(1);
    expect(a.calls).toStrictEqual(['authenticate', 'play']);
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar1', status: 'active', idempotencyKey: 'ak1' }]);
    a.close();
    const reloaded = world.open('a2');
    await settle();
    expect(reloaded.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995, winMinor: 95, grid: SMALL_GRID });
    expect(reloaded.port.received).toStrictEqual([{ type: 'authenticate' }, { type: 'authenticate' }, { type: 'endRound', roundId: 'ar1' }]);
    expect(reloaded.snapshots.map((snapshot) => snapshot.state.name)).toStrictEqual(['authenticating', 'restoring', 'authenticating', 'ending', 'idle']);
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar1', status: 'closed', idempotencyKey: 'ak1' }]);
    expect(await world.lockFree()).toBe(true);
  });

  it('ROUND_ACTIVE на спин: хозяин брошенного раунда закрылся — вкладка доигрывает его, свой спин не списан', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    const b = world.open('b', { seeds: [2] });
    await settle();
    a.lab.holdNextEndRound();
    a.controller.spin();
    await settle();
    expect(a.state).toStrictEqual({ name: 'ending', roundId: 'ar1' });
    a.close();
    b.controller.spin();
    await settle();
    expect(b.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995, winMinor: 95, grid: SMALL_GRID });
    expect(b.port.received).toStrictEqual([
      { type: 'authenticate' },
      { type: 'play', betMinor: 100, idempotencyKey: 'bk1' },
      { type: 'authenticate' },
      { type: 'endRound', roundId: 'ar1' },
    ]);
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar1', status: 'closed', idempotencyKey: 'ak1' }]);
  });

  it('endRound не нашёл раунда — его сняла починка в другой вкладке: сверка под замком, idle и полоса reset', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.lab.holdNextEndRound();
    a.controller.spin();
    await settle();
    await plant(world.storage, [
      { op: 'put', store: 'wallet', value: { id: 'main', balanceMinor: '99900', activeRoundId: 'ar1', nextSeq: 2, revision: 1, resetSeq: 1 } },
    ]);
    const b = world.open('b');
    await settle();
    expect(b.snapshot).toMatchObject({ state: IDLE, balanceMinor: 100_000, notice: 'reset' });
    a.lab.releaseHeld();
    await settle();
    expect(a.port.received.slice(-2)).toStrictEqual([{ type: 'endRound', roundId: 'ar1' }, { type: 'authenticate' }]);
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 100_000, notice: 'reset' });
    expect(await world.lockFree()).toBe(true);
  });
});

describe('чужая вкладка', () => {
  it('замок у другой вкладки — play не уходит; хозяин закончил — сверка и idle', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    const b = world.open('b');
    await settle();
    a.lab.holdNextEndRound();
    a.controller.spin();
    await settle();
    b.controller.spin();
    await settle();
    expect(b.state).toStrictEqual(WAITING);
    expect(b.calls).toStrictEqual(['authenticate']);
    a.lab.releaseHeld();
    await settle();
    expect(a.state).toStrictEqual(IDLE);
    expect(b.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995 });
    expect(b.calls).toStrictEqual(['authenticate', 'authenticate']);
    expect(balancePath(b)).toStrictEqual([null, 100_000, 99_900, 99_995]);
    expect(await world.lockFree()).toBe(true);
  });

  it('хозяин закрылся, пока вкладка ждёт: очередь отдаёт замок, вкладка доигрывает его раунд — одно зачисление', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    const b = world.open('b');
    await settle();
    a.lab.holdNextEndRound();
    a.controller.spin();
    await settle();
    b.controller.spin();
    await settle();
    a.close();
    await settle();
    expect(b.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995, winMinor: 95 });
    expect(b.calls).toStrictEqual(['authenticate', 'authenticate', 'endRound']);
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar1', status: 'closed', idempotencyKey: 'ak1' }]);
    expect(world.bus.sent.map((message) => message.balanceMinor)).toStrictEqual([99_900, 99_995]);
  });

  it('вкладка открылась посреди чужого раунда: ждёт в очереди и чужой раунд не трогает', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.lab.holdNextEndRound();
    a.controller.spin();
    await settle();
    const b = world.open('b');
    await settle();
    expect(b.state).toStrictEqual(WAITING);
    expect(b.snapshot.balanceMinor).toBe(99_900);
    a.lab.releaseHeld();
    await settle();
    expect(b.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995, grid: SMALL_GRID });
    expect(b.calls).toStrictEqual(['authenticate', 'authenticate']);
  });

  it('гонка: хозяин закончил между authenticate и захватом — сверка под замком не даёт показать раунд второй раз', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.lab.holdNextEndRound();
    a.controller.spin();
    await settle();
    let gate: GatedLock | null = null;
    const b = world.open('b', {
      wrapLock: (lock) => {
        gate = new GatedLock(lock);
        return gate;
      },
    });
    await settle();
    expect(b.state).toStrictEqual({ name: 'restoring', stage: 'lock', roundId: null });
    a.lab.releaseHeld();
    await settle();
    expect(a.state).toStrictEqual(IDLE);
    (gate as GatedLock | null)?.open();
    await settle();
    expect(b.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995 });
    expect(b.calls).toStrictEqual(['authenticate', 'authenticate']);
    expect(await world.lockFree()).toBe(true);
  });

  it('«Грати тут»: хозяин застрял на экране ошибки — замок отнят, хозяин бросает свой ключ и ждёт', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    const b = world.open('b', { seeds: [2] });
    await settle();
    a.lab.set({ requestLoss: 1 });
    a.controller.spin();
    await settle(18_760);
    expect(a.state.name).toBe('error');
    a.lab.set({ requestLoss: 0 });
    b.controller.spin();
    await settle();
    expect(b.state).toStrictEqual(WAITING);
    b.controller.takeOver();
    await settle();
    // Отнявшая сверилась под замком и отпустила его; брошенная дождалась своей очереди и тоже сверилась.
    expect(b.snapshot).toMatchObject({ state: IDLE, balanceMinor: 100_000 });
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 100_000 });
    expect(a.calls).toStrictEqual(['authenticate', 'authenticate']);
    a.controller.retry();
    await settle(20_000);
    expect(plays(a)).toStrictEqual([]);
    expect(await world.lockFree()).toBe(true);
    b.controller.spin();
    await settle();
    expect(b.snapshot).toMatchObject({ state: IDLE, balanceMinor: 100_090 });
  });

  it('«Грати тут»: раунд хозяина записан, ответы потеряны — отнявшая доигрывает его; одно списание, одно зачисление', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    const b = world.open('b');
    await settle();
    a.lab.set({ responseLoss: 1 });
    a.controller.spin();
    await settle(18_760);
    expect(a.state.name).toBe('error');
    const before = plays(a).length;
    a.lab.set({ responseLoss: 0 });
    b.controller.spin();
    await settle();
    b.controller.takeOver();
    await settle();
    expect(b.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995, winMinor: 95 });
    expect(b.port.received.slice(-2)).toStrictEqual([{ type: 'authenticate' }, { type: 'endRound', roundId: 'ar1' }]);
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995 });
    expect(plays(a)).toHaveLength(before);
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar1', status: 'closed', idempotencyKey: 'ak1' }]);
  });

  it('«Грати тут», пока хозяин повторяет play: брошенный вызов не повторяется, ключ больше не уходит', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    const b = world.open('b');
    await settle();
    a.lab.set({ responseLoss: 1 });
    a.controller.spin();
    await settle(4000);
    expect(a.state).toStrictEqual({ name: 'requesting', stage: 'play', key: 'ak1', betMinor: 100 });
    const before = plays(a).length;
    b.controller.spin();
    await settle();
    b.controller.takeOver();
    await settle(30_000);
    // Первая попытка записала раунд; отнявшая его доиграла. Повторы брошенного play не ушли.
    expect(plays(a)).toHaveLength(before);
    expect(b.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995 });
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar1', status: 'closed', idempotencyKey: 'ak1' }]);
  });

  it('«Грати тут», пока play хозяина в пути: брошенный play всё же записан — хозяин получает замок обратно и доигрывает', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    const b = world.open('b');
    await settle();
    a.lab.set({ latencyMs: 1000 });
    a.controller.spin();
    await settle(20);
    b.controller.spin();
    await settle(20);
    b.controller.takeOver();
    await settle(20);
    expect(b.snapshot).toMatchObject({ state: IDLE, balanceMinor: 100_000 });
    expect(a.state).toStrictEqual({ name: 'authenticating', holdsLock: true });
    await settle(3000);
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995, winMinor: 95 });
    expect(b.snapshot.balanceMinor).toBe(99_995);
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar1', status: 'closed', idempotencyKey: 'ak1' }]);
    expect(await world.lockFree()).toBe(true);
  });

  it('закрытие вкладки в очереди снимает её запрос: замок потом свободен', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    const b = world.open('b');
    await settle();
    a.lab.holdNextEndRound();
    a.controller.spin();
    await settle();
    b.controller.spin();
    await settle();
    b.close();
    a.lab.releaseHeld();
    await settle();
    expect(a.state).toStrictEqual(IDLE);
    expect(await world.lockFree()).toBe(true);
  });
});

describe('баланс и уведомления', () => {
  it('после починки ревизия началась заново — reset принят без сравнения, дальше баланс идёт по новой ревизии', async () => {
    const world = new ClientWorld();
    const a = world.open('a', { seeds: [2] });
    await settle();
    a.controller.spin();
    await settle();
    a.controller.spin();
    await settle();
    expect(a.snapshot.balanceMinor).toBe(100_180);
    const [wallet] = world.storage.snapshot().wallet;
    expect((wallet?.[1] as { revision: number }).revision).toBe(4);
    await plant(world.storage, [{ op: 'delete', store: 'wallet', key: 'main' }]);
    const b = world.open('b');
    await settle();
    expect(a.snapshot).toMatchObject({ balanceMinor: 100_000, notice: 'reset' });
    b.controller.spin();
    await settle();
    expect(a.snapshot.balanceMinor).toBe(99_995);
  });

  it('оповещения до первого authenticate копятся и применяются после него по ревизии', async () => {
    const world = new ClientWorld();
    let held: HeldPort | null = null;
    const a = world.open('a', {
      wrapPort: (inner) => {
        held = new HeldPort(inner);
        return held;
      },
    });
    const b = world.open('b');
    await settle();
    b.controller.spin();
    await settle();
    expect(a.state).toStrictEqual({ name: 'authenticating', holdsLock: false });
    (held as HeldPort | null)?.release();
    await settle();
    // authenticate a прочитан до спина b (ревизия 0): без накопленных оповещений баланс остался бы 100 000.
    expect(a.snapshot).toMatchObject({ state: IDLE, balanceMinor: 99_995 });
  });

  it('хранилище в памяти: полоса volatile, свой замок вкладки, оповещения других вкладок — мимо', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    const v = world.open('v', { storage: new MemoryStorage({ durable: false }), silent: true, seeds: [2] });
    await settle();
    expect(v.snapshot).toMatchObject({ state: IDLE, balanceMinor: 100_000, notice: 'volatile' });
    // Ревизии кошелька a (1–3) новее ревизии v (0): приняла бы — показала бы чужой баланс.
    a.controller.spin();
    await settle();
    a.lab.holdNextEndRound();
    a.controller.spin();
    await settle();
    expect(world.bus.sent.map((message) => message.revision)).toStrictEqual([1, 2, 3]);
    expect(v.snapshot.balanceMinor).toBe(100_000);
    expect(await world.lockFree()).toBe(false);
    v.controller.spin();
    await settle();
    expect(v.snapshot).toMatchObject({ state: IDLE, balanceMinor: 100_090, notice: 'volatile' });
    a.lab.releaseHeld();
    await settle();
    expect(a.snapshot.balanceMinor).toBe(99_990);
    expect(v.snapshot.balanceMinor).toBe(100_090);
  });

  it('хранилище в памяти: «Поповнити» — баланс из ответа resetBalance, оповещений нет вовсе', async () => {
    const world = new ClientWorld();
    const storage = new MemoryStorage({ durable: false });
    await plant(storage, [{ op: 'put', store: 'wallet', value: { id: 'main', balanceMinor: 50, activeRoundId: null, nextSeq: 1, revision: 3, resetSeq: 1 } }]);
    const v = world.open('v', { storage, silent: true });
    await settle();
    expect(v.snapshot).toMatchObject({ balanceMinor: 50, notice: 'volatile' });
    v.controller.refill();
    await settle();
    expect(v.snapshot).toMatchObject({ state: IDLE, balanceMinor: 100_000 });
    expect(world.bus.sent).toStrictEqual([]);
  });
});

describe('хранилище закрыто другой вкладкой', () => {
  it('storageClosed своего воркера — полоса versionchange поверх остальных; чужое и мусор — мимо', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.port.push({ v: 1, type: 'storageClosed', reason: 'other' });
    a.port.push({ v: 2, type: 'storageClosed', reason: 'versionchange' });
    a.port.push('storageClosed');
    await settle();
    expect(a.snapshot.notice).toBeNull();
    a.port.push({ v: 1, type: 'storageClosed', reason: 'versionchange' });
    await settle();
    expect(a.snapshot).toMatchObject({ state: IDLE, notice: 'versionchange' });
  });

  it('versionchange — и поверх volatile: воркер, поднятый заново после падения, открыл базу, и её обновили', async () => {
    const world = new ClientWorld();
    const v = world.open('v', { storage: new MemoryStorage({ durable: false }), silent: true });
    await settle();
    expect(v.snapshot.notice).toBe('volatile');
    v.port.push({ v: 1, type: 'storageClosed', reason: 'versionchange' });
    await settle();
    expect(v.snapshot.notice).toBe('versionchange');
  });

  it('после закрытия вкладки уведомления не слушаются', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    const published = a.snapshots.length;
    a.close();
    a.port.push({ v: 1, type: 'storageClosed', reason: 'versionchange' });
    await settle();
    expect(a.snapshots.length).toBe(published);
    expect(a.controller.getSnapshot().notice).toBeNull();
  });
});

describe('гонки и закрытие', () => {
  it('ответ пришёл в тот же миг, когда замок отняли: исход оборванного вызова не применяется', async () => {
    const rgs = new ManualRgs();
    const lock = new MemoryRoundLock();
    const controller = manualController(rgs, lock);
    controller.start();
    rgs.answer(0, AUTH_RESULT);
    await settle();
    controller.spin();
    await settle();
    expect(rgs.calls[1]?.body).toStrictEqual({ type: 'play', betMinor: 100, idempotencyKey: 'k1' });
    rgs.answer(1, PLAY_RESULT);
    void lock.steal();
    await settle();
    expect(rgs.calls[1]?.signal?.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ state: WAITING, balanceMinor: 100_000, winMinor: null, grid: DEMO_GRID });
  });

  it('«Грати тут» в миг, когда очередь уже выдала замок: замок принят один раз, у себя не отнимается', async () => {
    const rgs = new ManualRgs();
    const hand = new HandLock();
    const foreign = await hand.tryAcquire();
    const controller = manualController(rgs, hand);
    controller.start();
    rgs.answer(0, AUTH_RESULT);
    await settle();
    controller.spin();
    await settle();
    expect(controller.getSnapshot().state).toStrictEqual(WAITING);
    foreign?.release();
    const lease = await hand.tryAcquire();
    if (lease === null) throw new Error('замок не освободился');
    hand.grantQueued(lease);
    controller.takeOver();
    await settle();
    expect(hand.steals).toBe(0);
    expect(controller.getSnapshot().state).toStrictEqual({ name: 'authenticating', holdsLock: true });
    expect(rgs.calls.map((call) => call.body.type)).toStrictEqual(['authenticate', 'authenticate']);
    rgs.answer(1, AUTH_RESULT);
    await settle();
    expect(controller.getSnapshot().state).toStrictEqual(IDLE);
    expect(await hand.tryAcquire()).not.toBeNull();
  });

  it('закрытие обрывает запрос в пути; его ответ уже ничего не двигает', async () => {
    const rgs = new ManualRgs();
    const controller = manualController(rgs, new MemoryRoundLock());
    controller.start();
    controller.dispose();
    expect(rgs.calls[0]?.signal?.aborted).toBe(true);
    rgs.answer(0, AUTH_RESULT);
    await settle();
    expect(controller.getSnapshot().state).toStrictEqual({ name: 'authenticating', holdsLock: false });
  });

  it('закрытие, пока замок отвечает «занят»: машина стоит и в очередь не встаёт', async () => {
    const rgs = new ManualRgs();
    const lock = new MemoryRoundLock();
    const foreign = await lock.tryAcquire();
    const controller = manualController(rgs, lock);
    controller.start();
    rgs.answer(0, AUTH_RESULT);
    await settle();
    controller.spin();
    controller.dispose();
    await settle();
    expect(controller.getSnapshot().state).toStrictEqual({ name: 'requesting', stage: 'lock', key: 'k1', betMinor: 100 });
    foreign?.release();
    const next = await lock.tryAcquire();
    expect(next).not.toBeNull();
    next?.release();
  });

  it('замок, выданный после закрытия, отпускается сразу', async () => {
    const rgs = new ManualRgs();
    const lock = new MemoryRoundLock();
    const controller = manualController(rgs, lock);
    controller.start();
    rgs.answer(0, AUTH_RESULT);
    await settle();
    controller.spin();
    controller.dispose();
    await settle();
    const lease = await lock.tryAcquire();
    expect(lease).not.toBeNull();
    lease?.release();
  });
});

/** Замок раунда, который помнит каждое обращение. */
class WatchedLock implements RoundLock {
  readonly calls: string[] = [];
  readonly #inner: RoundLock;

  constructor(inner: RoundLock) {
    this.#inner = inner;
  }

  tryAcquire(): Promise<RoundLease | null> {
    this.calls.push('tryAcquire');
    return this.#inner.tryAcquire();
  }

  acquire(signal: AbortSignal): Promise<RoundLease> {
    this.calls.push('acquire');
    return this.#inner.acquire(signal);
  }

  steal(): Promise<RoundLease> {
    this.calls.push('steal');
    return this.#inner.steal();
  }
}

describe('повтор (?replay=)', () => {
  const MISSING = { name: 'error', kind: 'missing', retry: null, holdsLock: false };

  it('раунд своей истории: один запрос replay — ни authenticate, ни замка, ни книги; показ того же раунда, на панели ставка раунда, баланса нет', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    await settle();
    a.controller.spin();
    await settle();
    expect(roundsIn(world)).toStrictEqual([{ roundId: 'ar1', status: 'closed', idempotencyKey: 'ak1' }]);
    const before = world.storage.snapshot();
    let watched: WatchedLock | null = null;
    const r = world.replay('r', { round: 'ar1' }, {
      wrapLock: (lock) => {
        watched = new WatchedLock(lock);
        return watched;
      },
    });
    await settle();
    expect(r.calls).toStrictEqual(['replay']);
    expect(r.presentation.log).toStrictEqual([{ play: 'ar1' }]);
    expect(r.presentation.shown).toStrictEqual([{ roundId: 'ar1', betMinor: 100, winMinor: 95, events: SMALL.events }]);
    expect(r.state).toStrictEqual({ name: 'replaying', stage: 'done', roundId: 'ar1' });
    expect([r.snapshot.mode, r.snapshot.balanceMinor, r.snapshot.betMinor, r.snapshot.winMinor]).toStrictEqual(['replay', null, 100, 95]);
    expect((watched as WatchedLock | null)?.calls).toStrictEqual([]);
    expect(world.storage.snapshot()).toStrictEqual(before);
    // Спин, пополнение, «Повторити» и предзагрузка книги повтору не нужны: запросов больше нет.
    r.controller.spin();
    r.controller.refill();
    r.controller.retry();
    r.controller.prefetchBook();
    await settle();
    expect(r.calls).toStrictEqual(['replay']);
    // Деньги другой вкладки повтор не слышит.
    a.controller.spin();
    await settle();
    expect(a.snapshot.balanceMinor).toBe(99_990);
    expect(balancePath(r)).toStrictEqual([null]);
    expect(a.snapshot.mode).toBe('play');
  });

  it('запись книги: движок по сиду записи, ставка 1.00, показ — book-<index>; кошелёк не создан', async () => {
    const world = new ClientWorld();
    const r = world.replay('r', { book: 2 }, { rounds: { kind: 'book', loader: new ScriptedBookLoader() } });
    await settle();
    expect(r.calls).toStrictEqual(['replay']);
    expect(r.presentation.shown).toStrictEqual([{ roundId: 'book-2', betMinor: 100, winMinor: 190, events: fixtureRound('base-win').events }]);
    expect(r.state).toStrictEqual({ name: 'replaying', stage: 'done', roundId: 'book-2' });
    expect(world.storage.snapshot()).toStrictEqual({ wallet: [], rounds: [], keys: [], quarantine: [], fairness: [], secrets: [] });
  });

  it('раунда нет в истории браузера, записи нет в книге — экран «повтору нет» без «Повторити», запрос не повторяется', async () => {
    const world = new ClientWorld();
    const r = world.replay('r', { round: 'zz9' });
    const b = world.replay('b', { book: 3 }, { rounds: { kind: 'book', loader: new ScriptedBookLoader() } });
    await settle();
    expect([r.state, b.state]).toStrictEqual([MISSING, MISSING]);
    r.controller.retry();
    b.controller.retry();
    await settle();
    expect([r.calls, b.calls]).toStrictEqual([['replay'], ['replay']]);
    expect([r.presentation.log, b.presentation.log]).toStrictEqual([[], []]);
  });

  it('повтор после обычного запуска не действует: вкладка играет, книгу просит, деньги других вкладок слышит', async () => {
    const world = new ClientWorld();
    const a = world.open('a');
    const b = world.open('b');
    await settle();
    b.controller.startReplay({ round: 'ar1' });
    b.controller.prefetchBook();
    a.controller.spin();
    await settle();
    expect(b.calls).toStrictEqual(['authenticate', 'loadBook']);
    expect([b.snapshot.mode, b.state, b.snapshot.balanceMinor]).toStrictEqual(['play', IDLE, 99_995]);
  });

  it('книга не загрузилась — экран ошибки с «Повторити»; повтор запроса грузит книгу заново и показывает запись', async () => {
    const world = new ClientWorld();
    const loader = new ScriptedBookLoader(testBook(), 1);
    const r = world.replay('r', { book: 1 }, { rounds: { kind: 'book', loader } });
    await settle();
    expect(r.state).toStrictEqual({ name: 'error', kind: 'server', retry: { call: 'replay' }, holdsLock: false });
    r.controller.retry();
    await settle();
    expect([r.calls, loader.calls, r.state]).toStrictEqual([['replay', 'replay'], 2, { name: 'replaying', stage: 'done', roundId: 'book-1' }]);
    expect(r.presentation.shown.map((round) => [round.roundId, round.betMinor, round.winMinor])).toStrictEqual([['book-1', 100, 95]]);
  });
});
