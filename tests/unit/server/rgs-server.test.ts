import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import {
  MemoryStorage,
  RgsServer,
  StorageError,
  type CommitBatch,
  type CommitOutcome,
  type Lock,
  type Storage,
  type StoreKey,
  type StoreName,
} from '../../../src/server/index.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';
import { FixedClock, Rig, ScriptedEntropy, T0, plant } from '../../support/rgs-rig.ts';
import { verifyRound } from '../../support/round-model.ts';

// Правила сервера §6.2 литералами. Сиды — из фикстур, их итоги известны: 1 → 0, 0 → 35, 2 → 105, 512 → 155,
// 48 → 2585. Выигрыш посчитан вручную: floor(ставка × payX100 / 100).

const LOSS = fixtureRound('loss');
const SMALL = fixtureRound('small-win');
const BASE = fixtureRound('base-win');
const CASCADE = fixtureRound('cascade-3');
const FEATURE = fixtureRound('feature-start');

const EMPTY = { wallet: [], rounds: [], keys: [], quarantine: [] };
const BET_LEVELS = [20, 40, 100, 200, 400, 1000, 2000, 5000, 10000];

const firstGrid = (events: typeof FEATURE.events): readonly number[] => {
  const fill = events[0];
  if (fill?.t !== 'fill') throw new Error('раунд не начинается с fill');
  return fill.grid;
};

const play = (betMinor: number, idempotencyKey: string) => ({ type: 'play', betMinor, idempotencyKey });
const endRound = (roundId: string) => ({ type: 'endRound', roundId });
const AUTHENTICATE = { type: 'authenticate' };
const RESET = { type: 'resetBalance' };

describe('новый кошелёк', () => {
  it('authenticate ничего не пишет: 1000 кредитов, конфиг, заставка — fill сида 48', async () => {
    const rig = new Rig();
    expect(await rig.send(AUTHENTICATE)).toStrictEqual({
      ok: true,
      result: {
        balanceMinor: 100_000,
        config: { betLevelsMinor: BET_LEVELS, capX100: 500_000 },
        activeRound: null,
        idleGrid: firstGrid(FEATURE.events),
        notice: null,
        wallet: { balanceMinor: 100_000, revision: 0, notice: null },
      },
    });
    expect(rig.storage.snapshot()).toStrictEqual(EMPTY);
    expect(rig.broadcast.messages).toStrictEqual([]);
  });

  it('хранилище в памяти вместо IndexedDB — уведомление volatile', async () => {
    const rig = new Rig({ storage: new MemoryStorage({ durable: false }) });
    const response = await rig.send(AUTHENTICATE);
    expect(response.ok && (response.result as { notice: unknown }).notice).toBe('volatile');
  });
});

describe('play и endRound', () => {
  it('play списывает ставку и пишет раунд, кошелёк и ключ одной записью; endRound зачисляет и закрывает', async () => {
    const rig = new Rig({ seeds: [0] });
    expect(await rig.send(play(100, 'k1'))).toStrictEqual({
      ok: true,
      result: {
        round: { roundId: 'r1', betMinor: 100, payX100: 35, winMinor: 35, events: SMALL.events },
        balanceMinor: 99_900,
        wallet: { balanceMinor: 99_900, revision: 1, notice: null },
      },
    });
    const active = {
      roundId: 'r1',
      seq: 1,
      idempotencyKey: 'k1',
      betMinor: 100,
      seed: 0,
      payX100: 35,
      winMinor: 35,
      events: SMALL.events,
      createdAt: T0,
      status: 'active',
      balanceAfterBet: 99_900,
      balanceAfterEnd: null,
    };
    expect(rig.storage.snapshot()).toStrictEqual({
      wallet: [['main', { id: 'main', balanceMinor: 99_900, activeRoundId: 'r1', nextSeq: 2, revision: 1, resetSeq: 1 }]],
      rounds: [['r1', active]],
      keys: [['k1', { key: 'k1', roundId: 'r1', betMinor: 100 }]],
      quarantine: [],
    });

    expect(await rig.send(endRound('r1'))).toStrictEqual({
      ok: true,
      result: { balanceMinor: 99_935, wallet: { balanceMinor: 99_935, revision: 2, notice: null } },
    });
    expect(rig.storage.snapshot()).toStrictEqual({
      wallet: [['main', { id: 'main', balanceMinor: 99_935, activeRoundId: null, nextSeq: 2, revision: 2, resetSeq: 1 }]],
      rounds: [['r1', { ...active, status: 'closed', balanceAfterEnd: 99_935 }]],
      keys: [['k1', { key: 'k1', roundId: 'r1', betMinor: 100 }]],
      quarantine: [],
    });
    expect(rig.broadcast.messages).toStrictEqual([
      { v: 1, type: 'walletChanged', balanceMinor: 99_900, activeRoundId: 'r1', revision: 1, notice: null },
      { v: 1, type: 'walletChanged', balanceMinor: 99_935, activeRoundId: null, revision: 2, notice: null },
    ]);
  });

  it('пять раундов подряд: балансы и выигрыши — литералы', async () => {
    const rig = new Rig({ seeds: [0, 48, 1, 512, 2] });
    const rounds: [number, number, number, number, number][] = [
      // ставка, выигрыш, после ставки, после зачисления, payX100
      [100, 35, 99_900, 99_935, 35],
      [20, 517, 99_915, 100_432, 2585],
      [10_000, 0, 90_432, 90_432, 0],
      [1000, 1550, 89_432, 90_982, 155],
      [200, 210, 90_782, 90_992, 105],
    ];
    for (const [index, [bet, win, afterBet, afterEnd, payX100]] of rounds.entries()) {
      const played = await rig.send(play(bet, `k${String(index + 1)}`));
      expect(played.ok).toBe(true);
      if (!played.ok) return;
      const result = played.result as { round: { roundId: string; payX100: number; winMinor: number }; balanceMinor: number; wallet: unknown };
      expect([result.round.payX100, result.round.winMinor, result.balanceMinor]).toStrictEqual([payX100, win, afterBet]);
      // Две записи на раунд: play — нечётная ревизия, endRound — чётная.
      expect(result.wallet).toStrictEqual({ balanceMinor: afterBet, revision: 2 * index + 1, notice: null });
      expect(await rig.send(endRound(result.round.roundId))).toStrictEqual({
        ok: true,
        result: { balanceMinor: afterEnd, wallet: { balanceMinor: afterEnd, revision: 2 * index + 2, notice: null } },
      });
    }
    expect(rig.storage.snapshot().wallet).toStrictEqual([
      ['main', { id: 'main', balanceMinor: 90_992, activeRoundId: null, nextSeq: 6, revision: 10, resetSeq: 1 }],
    ]);
  });

  it('каждое оповещение уходит после записи: в хранилище уже лежит кошелёк этой ревизии', async () => {
    const rig = new Rig({ seeds: [0, 2] });
    await rig.send(play(100, 'k1'));
    await rig.send(endRound('r1'));
    await rig.send(play(100, 'k2'));
    await rig.send(RESET);
    expect(rig.broadcast.messages.map((message) => message.revision)).toStrictEqual([1, 2, 3]);
    await rig.send(endRound('r2'));
    await rig.send(RESET);
    expect(rig.broadcast.messages.map((message) => message.revision)).toStrictEqual([1, 2, 3, 4, 5]);
    const stored = rig.broadcast.storedAtSend as { balanceMinor: number; activeRoundId: string | null; revision: number }[];
    expect(stored.map(({ balanceMinor, activeRoundId, revision }) => ({ balanceMinor, activeRoundId, revision }))).toStrictEqual(
      rig.broadcast.messages.map(({ balanceMinor, activeRoundId, revision }) => ({ balanceMinor, activeRoundId, revision })),
    );
  });
});

describe('идемпотентность', () => {
  it('повтор play, чей ответ потерялся, пока раунд активен, — тот же раунд, а не ROUND_ACTIVE', async () => {
    const rig = new Rig({ seeds: [0] });
    const first = await rig.send(play(100, 'k1'));
    const written = rig.storage.snapshot();
    expect(await rig.send(play(100, 'k1'))).toStrictEqual(first);
    expect(rig.storage.snapshot()).toStrictEqual(written);
    expect(rig.entropy.used).toBe(1);
    expect(rig.broadcast.messages).toHaveLength(1);
  });

  it('повтор play после закрытия раунда — тот же раунд и баланс после его ставки, без списания; кошелёк — сегодняшний', async () => {
    const rig = new Rig({ seeds: [0] });
    await rig.send(play(100, 'k1'));
    await rig.send(endRound('r1'));
    const written = rig.storage.snapshot();
    expect(await rig.send(play(100, 'k1'))).toStrictEqual({
      ok: true,
      result: {
        round: { roundId: 'r1', betMinor: 100, payX100: 35, winMinor: 35, events: SMALL.events },
        balanceMinor: 99_900,
        wallet: { balanceMinor: 99_935, revision: 2, notice: null },
      },
    });
    expect(rig.storage.snapshot()).toStrictEqual(written);
  });

  it('тот же ключ с другой ставкой — IDEMPOTENCY_CONFLICT, ничего не записано', async () => {
    const rig = new Rig({ seeds: [0] });
    await rig.send(play(100, 'k1'));
    const written = rig.storage.snapshot();
    expect(await rig.send(play(200, 'k1'))).toStrictEqual({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(rig.storage.snapshot()).toStrictEqual(written);
  });

  it('повтор endRound — тот же ответ, без второго зачисления и без оповещения', async () => {
    const rig = new Rig({ seeds: [2] });
    await rig.send(play(1000, 'k1'));
    const ended = { ok: true, result: { balanceMinor: 100_050, wallet: { balanceMinor: 100_050, revision: 2, notice: null } } };
    expect(await rig.send(endRound('r1'))).toStrictEqual(ended);
    const written = rig.storage.snapshot();
    expect(await rig.send(endRound('r1'))).toStrictEqual(ended);
    expect(rig.storage.snapshot()).toStrictEqual(written);
    expect(rig.broadcast.messages).toHaveLength(2);
  });

  it('повтор endRound после новых записей — баланс после зачисления того раунда, кошелёк — сегодняшний', async () => {
    const rig = new Rig({ seeds: [2, 1] });
    await rig.send(play(1000, 'k1'));
    await rig.send(endRound('r1'));
    await rig.send(play(100, 'k2'));
    const written = rig.storage.snapshot();
    expect(await rig.send(endRound('r1'))).toStrictEqual({
      ok: true,
      result: { balanceMinor: 100_050, wallet: { balanceMinor: 99_950, revision: 3, notice: null } },
    });
    expect(rig.storage.snapshot()).toStrictEqual(written);
  });

  it('новый ключ при активном раунде — ROUND_ACTIVE с его id', async () => {
    const rig = new Rig({ seeds: [0] });
    await rig.send(play(100, 'k1'));
    const written = rig.storage.snapshot();
    expect(await rig.send(play(100, 'k2'))).toStrictEqual({ ok: false, error: { code: 'ROUND_ACTIVE', roundId: 'r1' } });
    expect(rig.storage.snapshot()).toStrictEqual(written);
  });

  it('окно идемпотентности — 100 раундов: 101-й вытесняет первый вместе с ключом, остальные на месте', async () => {
    const rig = new Rig({ seeds: new Array<number>(102).fill(1) });
    for (let n = 1; n <= 101; n++) {
      expect((await rig.send(play(20, `k${String(n)}`))).ok).toBe(true);
      expect((await rig.send(endRound(`r${String(n)}`))).ok).toBe(true);
    }
    const snapshot = rig.storage.snapshot();
    const expectedIds = Array.from({ length: 100 }, (_, index) => `r${String(index + 2)}`).sort();
    expect(snapshot.rounds.map(([key]) => key)).toStrictEqual(expectedIds);
    expect(snapshot.keys.map(([key]) => key)).toStrictEqual(expectedIds.map((id) => `k${id.slice(1)}`).sort());
    expect(snapshot.wallet).toStrictEqual([
      ['main', { id: 'main', balanceMinor: 100_000 - 20 * 101, activeRoundId: null, nextSeq: 102, revision: 202, resetSeq: 1 }],
    ]);
    // Ключ за окном забыт: повтор с ним — уже новый раунд. Предел записан в §6.2.
    const late = await rig.send(play(20, 'k1'));
    expect(late.ok && (late.result as { round: { roundId: string } }).round.roundId).toBe('r102');
  });
});

describe('отказы', () => {
  it('ставка не из уровней — INVALID_BET до замка: ни замка, ни энтропии, ни записи', async () => {
    let locked = 0;
    const lock: Lock = {
      withLock: (_name, task) => {
        locked += 1;
        return task();
      },
    };
    const rig = new Rig({ seeds: [0], lock });
    expect(await rig.send(play(30, 'k1'))).toStrictEqual({ ok: false, error: { code: 'INVALID_BET', betMinor: 30 } });
    expect(await rig.send(play(0, 'k1'))).toStrictEqual({ ok: false, error: { code: 'INVALID_BET', betMinor: 0 } });
    expect([locked, rig.entropy.used]).toStrictEqual([0, 0]);
    expect(rig.storage.snapshot()).toStrictEqual(EMPTY);
  });

  it('мало средств — INSUFFICIENT_FUNDS с балансом, движок не запускается', async () => {
    const storage = new MemoryStorage({ durable: true });
    await plant(storage, [
      { op: 'put', store: 'wallet', value: { id: 'main', balanceMinor: 50, activeRoundId: null, nextSeq: 1, revision: 4, resetSeq: 1 } },
    ]);
    const rig = new Rig({ storage, seeds: [0] });
    expect(await rig.send(play(100, 'k1'))).toStrictEqual({ ok: false, error: { code: 'INSUFFICIENT_FUNDS', balanceMinor: 50 } });
    expect(rig.entropy.used).toBe(0);
    expect((await rig.send(play(20, 'k2'))).ok).toBe(true);
  });

  it('endRound неизвестного раунда — ROUND_NOT_FOUND', async () => {
    const rig = new Rig();
    expect(await rig.send(endRound('r9'))).toStrictEqual({ ok: false, error: { code: 'ROUND_NOT_FOUND', roundId: 'r9' } });
  });

  it('не тот раунд при активном — ROUND_NOT_FOUND, активный не тронут', async () => {
    const rig = new Rig({ seeds: [0] });
    await rig.send(play(100, 'k1'));
    const written = rig.storage.snapshot();
    expect(await rig.send(endRound('r2'))).toStrictEqual({ ok: false, error: { code: 'ROUND_NOT_FOUND', roundId: 'r2' } });
    expect(rig.storage.snapshot()).toStrictEqual(written);
  });

  it('чужая версия и мусор — ответ без замка и записи; id запроса — в ответе, если прочитан', async () => {
    const rig = new Rig();
    expect(await rig.server.handle({ v: 2, id: 5, body: AUTHENTICATE })).toStrictEqual({
      v: 1,
      id: 5,
      body: { ok: false, error: { code: 'VERSION_MISMATCH', supported: 1 } },
    });
    expect(await rig.server.handle('authenticate')).toStrictEqual({
      v: 1,
      id: null,
      body: { ok: false, error: { code: 'BAD_REQUEST', message: 'конверт — не объект' } },
    });
    expect(await rig.server.handle({ v: 1, id: 6, body: { type: 'play', betMinor: 20 } })).toStrictEqual({
      v: 1,
      id: 6,
      body: { ok: false, error: { code: 'BAD_REQUEST', message: 'play: idempotencyKey — не ключ' } },
    });
    expect(rig.storage.snapshot()).toStrictEqual(EMPTY);
  });
});

describe('resetBalance', () => {
  it('возвращает 1000, resetSeq — с места сброса; при активном раунде — ROUND_ACTIVE', async () => {
    const rig = new Rig({ seeds: [1, 1] });
    await rig.send(play(10_000, 'k1'));
    await rig.send(endRound('r1'));
    await rig.send(play(10_000, 'k2'));
    const written = rig.storage.snapshot();
    expect(await rig.send(RESET)).toStrictEqual({ ok: false, error: { code: 'ROUND_ACTIVE', roundId: 'r2' } });
    expect(rig.storage.snapshot()).toStrictEqual(written);
    await rig.send(endRound('r2'));
    expect(await rig.send(RESET)).toStrictEqual({
      ok: true,
      result: { balanceMinor: 100_000, wallet: { balanceMinor: 100_000, revision: 5, notice: null } },
    });
    expect(rig.storage.snapshot().wallet).toStrictEqual([
      ['main', { id: 'main', balanceMinor: 100_000, activeRoundId: null, nextSeq: 3, revision: 5, resetSeq: 3 }],
    ]);
  });

  it('на новом кошельке — запись с resetSeq 1', async () => {
    const rig = new Rig();
    expect(await rig.send(RESET)).toStrictEqual({
      ok: true,
      result: { balanceMinor: 100_000, wallet: { balanceMinor: 100_000, revision: 1, notice: null } },
    });
    expect(rig.storage.snapshot().wallet).toStrictEqual([
      ['main', { id: 'main', balanceMinor: 100_000, activeRoundId: null, nextSeq: 1, revision: 1, resetSeq: 1 }],
    ]);
  });
});

describe('authenticate', () => {
  it('активный раунд — целиком; сетка покоя — итоговая сетка последнего закрытого', async () => {
    const rig = new Rig({ seeds: [0, 2] });
    await rig.send(play(100, 'k1'));
    await rig.send(endRound('r1'));
    await rig.send(play(100, 'k2'));
    expect(await rig.send(AUTHENTICATE)).toStrictEqual({
      ok: true,
      result: {
        balanceMinor: 99_835,
        config: { betLevelsMinor: BET_LEVELS, capX100: 500_000 },
        activeRound: { roundId: 'r2', betMinor: 100, payX100: 105, winMinor: 105, events: BASE.events },
        idleGrid: verifyRound(DEFAULT_CONFIG, SMALL.events).finalGrid,
        notice: null,
        wallet: { balanceMinor: 99_835, revision: 3, notice: null },
      },
    });
  });

  it('после закрытия — сетка этого раунда', async () => {
    const rig = new Rig({ seeds: [512] });
    await rig.send(play(100, 'k1'));
    await rig.send(endRound('r1'));
    const response = await rig.send(AUTHENTICATE);
    expect(response.ok && (response.result as { idleGrid: unknown }).idleGrid).toStrictEqual(
      verifyRound(DEFAULT_CONFIG, CASCADE.events).finalGrid,
    );
  });

  it('проигрыш тоже оставляет свою сетку — fill', async () => {
    const rig = new Rig({ seeds: [1] });
    await rig.send(play(100, 'k1'));
    await rig.send(endRound('r1'));
    const response = await rig.send(AUTHENTICATE);
    expect(response.ok && (response.result as { idleGrid: unknown }).idleGrid).toStrictEqual(firstGrid(LOSS.events));
  });
});

/** Хранилище со сбоями записи по сценарию: conflict — CAS не сошёлся, fail — транзакция упала. */
class FlakyStorage implements Storage {
  readonly durable = true;
  readonly #inner: MemoryStorage;
  readonly #script: ('conflict' | 'fail')[];

  constructor(inner: MemoryStorage, script: readonly ('conflict' | 'fail')[]) {
    this.#inner = inner;
    this.#script = [...script];
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
    const step = this.#script.shift();
    if (step === 'conflict') return Promise.resolve('conflict');
    if (step === 'fail') return Promise.reject(new StorageError('квота исчерпана'));
    return this.#inner.commit(batch);
  }
}

describe('сбои записи', () => {
  it('транзакция упала — INTERNAL, ничего не записано, оповещения нет; повтор с тем же ключом проходит', async () => {
    const rig = new Rig({ seeds: [0, 0], wrap: (inner) => new FlakyStorage(inner, ['fail']) });
    expect(await rig.send(play(100, 'k1'))).toStrictEqual({ ok: false, error: { code: 'INTERNAL', message: 'квота исчерпана' } });
    expect(rig.storage.snapshot()).toStrictEqual(EMPTY);
    expect(rig.broadcast.messages).toStrictEqual([]);
    const retry = await rig.send(play(100, 'k1'));
    expect(retry.ok).toBe(true);
    expect(rig.storage.snapshot().keys).toStrictEqual([['k1', { key: 'k1', roundId: 'r2', betMinor: 100 }]]);
  });

  it('CAS не сошёлся один раз — операция заново, с новым сидом: записан второй розыгрыш', async () => {
    const rig = new Rig({ seeds: [0, 2], wrap: (inner) => new FlakyStorage(inner, ['conflict']) });
    expect(await rig.send(play(100, 'k1'))).toStrictEqual({
      ok: true,
      result: {
        round: { roundId: 'r2', betMinor: 100, payX100: 105, winMinor: 105, events: BASE.events },
        balanceMinor: 99_900,
        wallet: { balanceMinor: 99_900, revision: 1, notice: null },
      },
    });
    expect(rig.broadcast.messages).toHaveLength(1);
  });

  it('три конфликта подряд — INTERNAL, ничего не записано', async () => {
    const rig = new Rig({ seeds: [0, 0, 0], wrap: (inner) => new FlakyStorage(inner, ['conflict', 'conflict', 'conflict']) });
    expect(await rig.send(play(100, 'k1'))).toStrictEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'кошелёк изменился между чтением и записью' },
    });
    expect([rig.entropy.used, rig.broadcast.messages.length]).toStrictEqual([3, 0]);
    expect(rig.storage.snapshot()).toStrictEqual(EMPTY);
  });

  it('сбой оповещения деньги не трогает: запись сделана, ответ ушёл', async () => {
    const storage = new MemoryStorage({ durable: true });
    const server = new RgsServer(
      {
        storage,
        lock: { withLock: (_name, task) => task() },
        clock: new FixedClock(T0),
        entropy: new ScriptedEntropy([0]),
        broadcast: {
          walletChanged: () => {
            throw new Error('канал закрыт');
          },
        },
      },
      { config: DEFAULT_CONFIG },
    );
    const response = await server.handle({ v: 1, id: 1, body: play(100, 'k1') });
    expect(response.body.ok).toBe(true);
    expect(storage.snapshot().wallet).toHaveLength(1);
  });
});
