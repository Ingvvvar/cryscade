import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { RECORD_LIMIT } from '../../../src/server/records.ts';
import { ForcedRoundSource } from '../../../src/server/forced-round-source.ts';
import { MemoryLock, MemoryStorage, RgsServer } from '../../../src/server/index.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';
import { NodeCrypto } from '../../support/node-crypto.ts';
import { BroadcastLog, FixedClock, Rig, ScriptedEntropy, T0, plant } from '../../support/rgs-rig.ts';
import { ScriptedBookLoader, testBook } from '../../support/test-book.ts';

// Сервер с книгой (§7, фаза 6): честность создаётся до игры, раунд выбирается по HMAC, nonce растёт в той же записи,
// что списание; смена сида раскрывает секрет. Ожидания считаются здесь заново: байты сценария стенда — первые байты
// SHA-256 строки «:k» (соль стенда пустая, k — номер вызова), обязательство — node:crypto, индекс — перебором
// накопленных весов тестовой книги 5 | 8 | 10.

const bytesOf = (call: number, length: number): Buffer => createHash('sha256').update(`:${String(call)}`).digest().subarray(0, length);
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
/** Вызовы байтов стенда по порядку: 0 — первый секрет, 1 — сид игрока по умолчанию, 2 — следующий секрет. */
const X0 = bytesOf(0, 32).toString('hex');
const C0 = sha256(bytesOf(0, 32));
const S0 = bytesOf(1, 8).toString('hex');
const X1 = bytesOf(2, 32).toString('hex');
const C1 = sha256(bytesOf(2, 32));

const LIMIT = (2n ** 64n / 10n) * 10n;
/** Индекс тестовой книги для (секрет, сид, nonce): HMAC node:crypto, отбрасывание, перебор весов. */
function expectedIndex(secret: string, clientSeed: string, nonce: number): number {
  for (let counter = 0; counter < 64; counter++) {
    const value = createHmac('sha256', Buffer.from(secret, 'hex')).update(`${clientSeed}:${String(nonce)}:${String(counter)}`).digest().readBigUInt64BE(0);
    if (value >= LIMIT) continue;
    const point = Number(value % 10n);
    return point < 5 ? 0 : point < 8 ? 1 : 2;
  }
  throw new Error('не выбрано');
}
const RECORDS = [
  { seed: 1, payX100: 0, fixture: 'loss' },
  { seed: 0, payX100: 95, fixture: 'small-win' },
  { seed: 2, payX100: 190, fixture: 'base-win' },
] as const;

/** Закрытый раунд v1 (живой, без полей честности): small-win, сид 0, ставка 100 → 95. */
const HISTORY_ROUND = {
  roundId: 'r6',
  seq: 6,
  idempotencyKey: 'k6',
  betMinor: 100,
  seed: 0,
  payX100: 95,
  winMinor: 95,
  events: fixtureRound('small-win').events,
  createdAt: T0,
  status: 'closed',
  balanceAfterBet: 99_900,
  balanceAfterEnd: 99_995,
};

const AUTHENTICATE = { type: 'authenticate' };
const play = (betMinor: number, idempotencyKey: string) => ({ type: 'play', betMinor, idempotencyKey });
const endRound = (roundId: string) => ({ type: 'endRound', roundId });

function bookRig(loader = new ScriptedBookLoader()): Rig {
  return new Rig({ rounds: { kind: 'book', loader } });
}

async function result(rig: Rig, body: unknown): Promise<Record<string, unknown>> {
  const response = await rig.send(body);
  if (!response.ok) throw new Error(`отказ: ${JSON.stringify(response.error)}`);
  return response.result as Record<string, unknown>;
}

describe('честность до игры', () => {
  it('authenticate создаёт секрет, обязательство и сид игрока; nonce 0 — одна запись, ревизия 1', async () => {
    const rig = bookRig();
    const auth = await result(rig, AUTHENTICATE);
    expect(auth['fairness']).toStrictEqual({ commitment: C0, clientSeed: S0, nonce: 0 });
    expect(rig.storage.snapshot()).toMatchObject({
      wallet: [['main', { id: 'main', balanceMinor: 100_000, activeRoundId: null, nextSeq: 1, revision: 1, resetSeq: 1 }]],
      fairness: [['main', { id: 'main', commitment: C0, clientSeed: S0, nonce: 0 }]],
      secrets: [[C0, { commitment: C0, secret: X0, createdAt: T0, revealedAt: null }]],
    });
    expect(rig.broadcast.messages.map((message) => message.revision)).toStrictEqual([1]);
    // Повторный authenticate ничего не пишет: честность цела.
    await result(rig, AUTHENTICATE);
    expect(rig.broadcast.messages).toHaveLength(1);
  });
});

describe('раунд из книги', () => {
  it('play: индекс — HMAC(секрет, сид:nonce:counter), раунд — движок по сиду записи; nonce + 1 в той же записи', async () => {
    const rig = bookRig();
    await result(rig, AUTHENTICATE);
    const nonces: number[] = [];
    for (let round = 1; round <= 5; round++) {
      const played = await result(rig, play(100, `k${String(round)}`));
      const index = expectedIndex(X0, S0, round - 1);
      const record = RECORDS[index];
      if (record === undefined) throw new Error('нет записи');
      const view = played['round'] as Record<string, unknown>;
      expect([view['source'], view['bookIndex'], view['nonce'], view['payX100']]).toStrictEqual(['book', index, round - 1, record.payX100]);
      expect(view['events']).toStrictEqual(fixtureRound(record.fixture).events);
      const stored = rig.storage.snapshot();
      expect(stored.fairness).toStrictEqual([['main', { id: 'main', commitment: C0, clientSeed: S0, nonce: round }]]);
      expect(stored.rounds.find(([key]) => key === `r${String(round)}`)?.[1]).toMatchObject({
        seed: record.seed,
        source: 'book',
        bookIndex: index,
        nonce: round - 1,
        commitment: C0,
        clientSeed: S0,
      });
      nonces.push(round - 1);
      await result(rig, endRound(`r${String(round)}`));
    }
    expect(nonces).toStrictEqual([0, 1, 2, 3, 4]);
  });

  it('повтор play с тем же ключом — тот же раунд с тем же nonce, nonce не растёт', async () => {
    const rig = bookRig();
    await result(rig, AUTHENTICATE);
    const first = await result(rig, play(100, 'k1'));
    const again = await result(rig, play(100, 'k1'));
    expect(again['round']).toStrictEqual(first['round']);
    expect(rig.storage.snapshot().fairness).toStrictEqual([['main', { id: 'main', commitment: C0, clientSeed: S0, nonce: 1 }]]);
  });

  it('принудительный раунд рядом с книгой — forced: nonce не тратит, полей честности нет', async () => {
    const storage = new MemoryStorage({ durable: true });
    const holder: { forced: ForcedRoundSource | null } = { forced: null };
    const server = new RgsServer(
      { storage, lock: new MemoryLock(), clock: new FixedClock(T0), entropy: new ScriptedEntropy([]), broadcast: new BroadcastLog(storage), crypto: new NodeCrypto() },
      {
        config: DEFAULT_CONFIG,
        rounds: { kind: 'book', loader: new ScriptedBookLoader() },
        decorateSource: (inner, rounds) => (holder.forced = new ForcedRoundSource(inner, rounds)),
      },
    );
    await server.handle({ v: 1, id: 1, body: AUTHENTICATE });
    holder.forced?.force(48);
    const response = await server.handle({ v: 1, id: 2, body: play(100, 'k1') });
    expect(response.body.ok && (response.body.result as { round: unknown }).round).toMatchObject({ source: 'forced', bookIndex: null, nonce: null, payX100: 3350 });
    const snapshot = storage.snapshot();
    expect(snapshot.fairness).toStrictEqual([['main', { id: 'main', commitment: C0, clientSeed: S0, nonce: 0 }]]);
    expect(snapshot.rounds[0]?.[1]).toMatchObject({ seed: 48, source: 'forced', bookIndex: null, nonce: null, commitment: null, clientSeed: null });
  });
});

describe('контрпримеры property сверки кошелька', () => {
  it('сид 1192308355: первый play на новом кошельке — честность создаётся тем же запросом, CAS без конфликта', async () => {
    const outcomes: string[] = [];
    const rig = new Rig({
      rounds: { kind: 'book', loader: new ScriptedBookLoader() },
      wrap: (inner) => ({
        durable: true,
        get: (...args) => inner.get(...args),
        keysByIndex: (...args) => inner.keysByIndex(...args),
        lastByIndex: (...args) => inner.lastByIndex(...args),
        descend: (...args) => inner.descend(...args),
        commit: async (batch) => {
          const outcome = await inner.commit(batch);
          outcomes.push(outcome);
          return outcome;
        },
      }),
    });
    const played = await result(rig, play(100, 'k1'));
    expect((played['round'] as Record<string, unknown>)['nonce']).toBe(0);
    expect(outcomes).toStrictEqual(['committed', 'committed']);
    expect(rig.broadcast.messages.map((message) => message.revision)).toStrictEqual([1, 2]);
  });

  it('сид 331888139 (стенд): новый секрет совпал с записанным — сломанная энтропия — INTERNAL, ничего не записано', async () => {
    const rig = bookRig();
    await result(rig, AUTHENTICATE);
    // Следующий секрет стенда — вызов 2; его запись уже лежит — add не пройдёт.
    await plant(rig.storage, [{ op: 'put', store: 'secrets', value: { commitment: C1, secret: X1, createdAt: T0, revealedAt: null } }]);
    const written = rig.storage.snapshot();
    const rotated = await rig.send({ type: 'rotateSeed' });
    expect(rotated.ok ? null : rotated.error.code).toBe('INTERNAL');
    expect(rig.storage.snapshot()).toStrictEqual(written);
  });
});

describe('смена секрета и сида', () => {
  it('rotateSeed: прежний секрет раскрыт, новое обязательство, nonce с нуля, сид игрока тот же', async () => {
    const rig = bookRig();
    await result(rig, AUTHENTICATE);
    await result(rig, play(100, 'k1'));
    expect(await rig.send({ type: 'rotateSeed' })).toStrictEqual({ ok: false, error: { code: 'ROUND_ACTIVE', roundId: 'r1' } });
    await result(rig, endRound('r1'));
    expect(await result(rig, { type: 'rotateSeed' })).toStrictEqual({ fairness: { commitment: C1, clientSeed: S0, nonce: 0 }, revealed: { commitment: C0, secret: X0 } });
    const snapshot = rig.storage.snapshot();
    expect(snapshot.fairness).toStrictEqual([['main', { id: 'main', commitment: C1, clientSeed: S0, nonce: 0 }]]);
    const secrets: [string, unknown][] = [
      [C0, { commitment: C0, secret: X0, createdAt: T0, revealedAt: T0 }],
      [C1, { commitment: C1, secret: X1, createdAt: T0, revealedAt: null }],
    ];
    // Хранилище отдаёт записи по возрастанию ключа — обязательства.
    expect(snapshot.secrets).toStrictEqual(secrets.sort(([a], [b]) => (a < b ? -1 : 1)));
    // Следующий раунд — под новым секретом, nonce 0.
    const played = await result(rig, play(100, 'k2'));
    expect((played['round'] as Record<string, unknown>)['bookIndex']).toBe(expectedIndex(X1, S0, 0));
  });

  it('setClientSeed: новый сид, новый секрет, прежний раскрыт; сид не по формату — BAD_REQUEST, ничего не записано', async () => {
    const rig = bookRig();
    await result(rig, AUTHENTICATE);
    const bad = await rig.send({ type: 'setClientSeed', clientSeed: 'a:b' });
    expect(bad.ok ? null : bad.error.code).toBe('BAD_REQUEST');
    expect(await result(rig, { type: 'setClientSeed', clientSeed: 'Lucky7' })).toStrictEqual({
      fairness: { commitment: C1, clientSeed: 'Lucky7', nonce: 0 },
      revealed: { commitment: C0, secret: X0 },
    });
    const played = await result(rig, play(100, 'k1'));
    expect((played['round'] as Record<string, unknown>)['bookIndex']).toBe(expectedIndex(X1, 'Lucky7', 0));
  });
});

describe('история и повтор', () => {
  it('history: новые первыми, у раунда книги — индекс, nonce, обязательство; секрет — после раскрытия', async () => {
    const rig = bookRig();
    await result(rig, AUTHENTICATE);
    await result(rig, play(100, 'k1'));
    await result(rig, endRound('r1'));
    await result(rig, play(100, 'k2'));
    const before = (await result(rig, { type: 'history', limit: 10 }))['rounds'] as Record<string, unknown>[];
    expect(before.map((entry) => [entry['roundId'], entry['status'], entry['nonce'], entry['commitment'], entry['secret']])).toStrictEqual([
      ['r2', 'active', 1, C0, null],
      ['r1', 'closed', 0, C0, null],
    ]);
    await result(rig, endRound('r2'));
    await result(rig, { type: 'rotateSeed' });
    const after = (await result(rig, { type: 'history', limit: 1 }))['rounds'] as Record<string, unknown>[];
    expect(after).toStrictEqual([
      {
        roundId: 'r2',
        createdAt: T0,
        betMinor: 100,
        payX100: RECORDS[expectedIndex(X0, S0, 1)]?.payX100,
        winMinor: RECORDS[expectedIndex(X0, S0, 1)]?.payX100,
        status: 'closed',
        source: 'book',
        bookIndex: expectedIndex(X0, S0, 1),
        nonce: 1,
        commitment: C0,
        clientSeed: S0,
        secret: X0,
      },
    ]);
  });

  it('раунд v1 без полей честности — в истории live, «до честности»', async () => {
    const storage = new MemoryStorage({ durable: true });
    const small = fixtureRound('small-win');
    await plant(storage, [
      { op: 'put', store: 'wallet', value: { id: 'main', balanceMinor: 99_995, activeRoundId: null, nextSeq: 2, revision: 2, resetSeq: 1 } },
      {
        op: 'put',
        store: 'rounds',
        value: {
          roundId: 'old1',
          seq: 1,
          idempotencyKey: 'q1',
          betMinor: 100,
          seed: 0,
          payX100: 95,
          winMinor: 95,
          events: small.events,
          createdAt: T0,
          status: 'closed',
          balanceAfterBet: 99_900,
          balanceAfterEnd: 99_995,
        },
      },
    ]);
    const rig = new Rig({ storage, rounds: { kind: 'book', loader: new ScriptedBookLoader() } });
    const rounds = (await result(rig, { type: 'history', limit: 5 }))['rounds'] as Record<string, unknown>[];
    expect(rounds.map((entry) => [entry['roundId'], entry['source'], entry['bookIndex'], entry['nonce'], entry['commitment'], entry['secret']])).toStrictEqual([
      ['old1', 'live', null, null, null, null],
    ]);
  });

  it('replay раунда истории и записи книги — события без движения денег; индекс вне книги — BAD_REQUEST', async () => {
    const rig = bookRig();
    await result(rig, AUTHENTICATE);
    await result(rig, play(100, 'k1'));
    const written = rig.storage.snapshot();
    const index = expectedIndex(X0, S0, 0);
    expect(await result(rig, { type: 'replay', round: 'r1' })).toStrictEqual({
      roundId: 'r1',
      bookIndex: null,
      betMinor: 100,
      payX100: RECORDS[index]?.payX100,
      winMinor: RECORDS[index]?.payX100,
      events: fixtureRound(RECORDS[index]?.fixture ?? 'loss').events,
    });
    expect(await result(rig, { type: 'replay', book: 2 })).toStrictEqual({
      roundId: null,
      bookIndex: 2,
      betMinor: 100,
      payX100: 190,
      winMinor: 190,
      events: fixtureRound('base-win').events,
    });
    const outside = await rig.send({ type: 'replay', book: 3 });
    expect(outside.ok ? null : outside.error).toStrictEqual({ code: 'BAD_REQUEST', message: 'индекс книги 3 вне 0…2' });
    const missing = await rig.send({ type: 'replay', round: 'nope' });
    expect(missing.ok ? null : missing.error).toStrictEqual({ code: 'ROUND_NOT_FOUND', roundId: 'nope' });
    expect(rig.storage.snapshot()).toStrictEqual(written);
  });
});

describe('загрузка книги', () => {
  it('не загрузилась — INTERNAL с понятным текстом, ничего не записано; следующий play грузит заново и играет', async () => {
    const loader = new ScriptedBookLoader(testBook(), 1);
    const rig = bookRig(loader);
    await result(rig, AUTHENTICATE);
    const written = rig.storage.snapshot();
    expect(await rig.send(play(100, 'k1'))).toStrictEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'книга исходов не загрузилась: SHA-256 не сошёлся с эталоном' },
    });
    expect(rig.storage.snapshot()).toStrictEqual(written);
    const played = await result(rig, play(100, 'k1'));
    expect((played['round'] as Record<string, unknown>)['source']).toBe('book');
    expect(loader.calls).toBe(2);
    // Загружена — больше не качается.
    expect(await result(rig, { type: 'loadBook' })).toStrictEqual({ records: 3 });
    expect(loader.calls).toBe(2);
  });

  it('живой источник — честности нет: authenticate без неё, смена сида, загрузка книги и пересчёт — BAD_REQUEST', async () => {
    const rig = new Rig();
    expect((await result(rig, AUTHENTICATE))['fairness']).toBeNull();
    const NO_FAIRNESS = 'честности нет: источник раундов — живой';
    const NO_BOOK = 'книги нет: источник раундов — живой';
    for (const [body, message] of [
      [{ type: 'rotateSeed' }, NO_FAIRNESS],
      [{ type: 'setClientSeed', clientSeed: 'a' }, NO_FAIRNESS],
      [{ type: 'loadBook' }, NO_BOOK],
      [{ type: 'replay', book: 0 }, NO_BOOK],
      [{ type: 'verify', secret: X0, clientSeed: 'a', nonce: 0 }, NO_BOOK],
    ] as const) {
      expect(await rig.send(body), JSON.stringify(body)).toStrictEqual({ ok: false, error: { code: 'BAD_REQUEST', message } });
    }
  });

  it('книгу грузят только те запросы, которым она нужна: loadBook и повтор записи — даже первыми', async () => {
    const first = new ScriptedBookLoader();
    expect(await result(bookRig(first), { type: 'loadBook' })).toStrictEqual({ records: 3 });
    expect(first.calls).toBe(1);
    const replayed = await result(bookRig(), { type: 'replay', book: 1 });
    expect([replayed['bookIndex'], replayed['payX100'], replayed['events']]).toStrictEqual([1, 95, fixtureRound('small-win').events]);
  });

  it('книга не грузится — повтору раунда истории и запросу с чужим полем book это не мешает: их книга не нужна', async () => {
    const broken = new ScriptedBookLoader(testBook(), 99);
    const storage = new MemoryStorage({ durable: true });
    await plant(storage, [{ op: 'put', store: 'rounds', value: HISTORY_ROUND }]);
    const rig = new Rig({ storage, rounds: { kind: 'book', loader: broken } });
    expect((await result(rig, { type: 'replay', round: 'r6' }))['events']).toStrictEqual(fixtureRound('small-win').events);
    expect((await result(rig, { type: 'history', limit: 5, book: 0 }))['rounds']).toHaveLength(1);
    expect(broken.calls).toBe(0);
  });

  it('запись книги разошлась с движком — повтор записи INTERNAL с её номером, а не неправда', async () => {
    const lying = testBook([
      { seed: 1, payX100: 0, weight: 5 },
      { seed: 0, payX100: 96, weight: 3 },
    ]);
    const rig = bookRig(new ScriptedBookLoader(lying));
    expect(await rig.send({ type: 'replay', book: 1 })).toStrictEqual({ ok: false, error: { code: 'INTERNAL', message: 'книга и движок разошлись: запись 1' } });
  });
});

describe('пересчёт выбора (verify, панель «Перевірити»)', () => {
  it('раскрытый секрет: обязательство и запись книги — те же, что у сыгранного раунда; ничего не записано', async () => {
    const rig = bookRig();
    await result(rig, AUTHENTICATE);
    const played = (await result(rig, play(100, 'k1')))['round'] as Record<string, unknown>;
    await result(rig, endRound('r1'));
    await result(rig, { type: 'rotateSeed' });
    const before = rig.storage.snapshot();
    const index = expectedIndex(X0, S0, 0);
    const verified = await result(rig, { type: 'verify', secret: X0, clientSeed: S0, nonce: 0 });
    expect(verified).toStrictEqual({ commitment: C0, bookIndex: index, counter: 0, payX100: RECORDS[index]?.payX100 });
    expect([verified['bookIndex'], verified['payX100']]).toStrictEqual([played['bookIndex'], played['payX100']]);
    expect(rig.storage.snapshot()).toStrictEqual(before);
  });

  it('чужой секрет — его обязательство и его выбор; секрет, сид или nonce не по формату — BAD_REQUEST', async () => {
    const rig = bookRig();
    const other = 'ab'.repeat(32);
    expect(await result(rig, { type: 'verify', secret: other, clientSeed: 'Lucky7', nonce: 3 })).toStrictEqual({
      commitment: sha256(Buffer.from(other, 'hex')),
      bookIndex: expectedIndex(other, 'Lucky7', 3),
      counter: 0,
      payX100: RECORDS[expectedIndex(other, 'Lucky7', 3)]?.payX100,
    });
    for (const body of [
      { type: 'verify', secret: 'AB'.repeat(32), clientSeed: 'a', nonce: 0 },
      { type: 'verify', secret: 'ab'.repeat(31), clientSeed: 'a', nonce: 0 },
      { type: 'verify', secret: other, clientSeed: 'a:b', nonce: 0 },
      { type: 'verify', secret: other, clientSeed: 'a', nonce: -1 },
      { type: 'verify', secret: other, clientSeed: 'a', nonce: 1.5 },
      { type: 'verify', secret: other, clientSeed: 'a', nonce: 2 ** 53 },
      { type: 'verify', clientSeed: 'a', nonce: 0 },
    ]) {
      const response = await rig.send(body);
      expect(response.ok ? null : response.error.code, JSON.stringify(body)).toBe('BAD_REQUEST');
    }
  });

  it('значение за границей на counter 0 — выбор с counter 1, как у раунда', async () => {
    // HMAC стенда: для сообщения на counter 0 — восемь байт 0xff (за границей), иначе node:crypto.
    const scripted = {
      hmacSha256: (key: Uint8Array, message: Uint8Array): Promise<Uint8Array> =>
        Promise.resolve(new TextDecoder().decode(message).endsWith(':0') ? new Uint8Array(32).fill(0xff) : new Uint8Array(createHmac('sha256', key).update(message).digest())),
      sha256: (data: Uint8Array): Promise<Uint8Array> => Promise.resolve(new Uint8Array(createHash('sha256').update(data).digest())),
    };
    const rig = new Rig({ rounds: { kind: 'book', loader: new ScriptedBookLoader() }, crypto: scripted });
    const value = createHmac('sha256', Buffer.from(X0, 'hex')).update('Seed1:4:1').digest().readBigUInt64BE(0);
    const point = Number(value % 10n);
    const index = point < 5 ? 0 : point < 8 ? 1 : 2;
    expect(await result(rig, { type: 'verify', secret: X0, clientSeed: 'Seed1', nonce: 4 })).toStrictEqual({
      commitment: C0,
      bookIndex: index,
      counter: 1,
      payX100: RECORDS[index].payX100,
    });
  });

  it('книга не загрузилась — INTERNAL; следующий пересчёт грузит её заново', async () => {
    const rig = bookRig(new ScriptedBookLoader(testBook(), 1));
    const failed = await rig.send({ type: 'verify', secret: X0, clientSeed: S0, nonce: 0 });
    expect(failed.ok ? null : failed.error.code).toBe('INTERNAL');
    expect((await result(rig, { type: 'verify', secret: X0, clientSeed: S0, nonce: 0 }))['commitment']).toBe(C0);
  });
});

describe('испорченная честность', () => {
  it('запись честности испорчена — в карантин; новый секрет, сид игрока по умолчанию, nonce 0', async () => {
    const storage = new MemoryStorage({ durable: true });
    await plant(storage, [{ op: 'put', store: 'fairness', value: { id: 'main', commitment: 'x', clientSeed: 'ok', nonce: 3 } }]);
    const rig = new Rig({ storage, rounds: { kind: 'book', loader: new ScriptedBookLoader() } });
    expect((await result(rig, AUTHENTICATE))['fairness']).toStrictEqual({ commitment: C0, clientSeed: S0, nonce: 0 });
    expect(storage.snapshot().quarantine).toStrictEqual([
      [1, { store: 'fairness', raw: { id: 'main', commitment: 'x', clientSeed: 'ok', nonce: 3 }, reason: 'честность: обязательство — не 64 знака hex', at: T0 }],
    ]);
  });

  it('секрета под обязательством нет или он не даёт обязательство — новый секрет; сид игрока — прежний', async () => {
    for (const secret of [null, { commitment: C1, secret: X0, createdAt: T0, revealedAt: null }]) {
      const storage = new MemoryStorage({ durable: true });
      await plant(storage, [
        { op: 'put', store: 'fairness', value: { id: 'main', commitment: C1, clientSeed: 'Mine', nonce: 9 } },
        ...(secret === null ? [] : [{ op: 'put' as const, store: 'secrets' as const, value: secret }]),
      ]);
      const rig = new Rig({ storage, rounds: { kind: 'book', loader: new ScriptedBookLoader() } });
      // Байты сценария: вызов 0 — новый секрет (сид игрока не нужен — он цел).
      expect((await result(rig, AUTHENTICATE))['fairness']).toStrictEqual({ commitment: C0, clientSeed: 'Mine', nonce: 0 });
    }
  });

  /** Честность с секретом C1 и nonce, секрет X1 цел; раскрыт — если revealedAt задан. */
  async function fairnessRig(nonce: number, revealedAt: number | null): Promise<Rig> {
    const storage = new MemoryStorage({ durable: true });
    await plant(storage, [
      { op: 'put', store: 'fairness', value: { id: 'main', commitment: C1, clientSeed: 'Mine', nonce } },
      { op: 'put', store: 'secrets', value: { commitment: C1, secret: X1, createdAt: T0, revealedAt } },
    ]);
    return new Rig({ storage, rounds: { kind: 'book', loader: new ScriptedBookLoader() } });
  }

  it('секрет под обязательством уже раскрыт — им не играют: новый секрет, nonce 0', async () => {
    expect((await result(await fairnessRig(9, T0), AUTHENTICATE))['fairness']).toStrictEqual({ commitment: C0, clientSeed: 'Mine', nonce: 0 });
  });

  it.each([
    ['nonce 2^52 — следующий раунд перешёл бы границу записей: новый секрет, nonce 0', RECORD_LIMIT, { commitment: C0, clientSeed: 'Mine', nonce: 0 }],
    ['nonce 2^52 − 1 — ещё один раунд помещается: честность прежняя', RECORD_LIMIT - 1, { commitment: C1, clientSeed: 'Mine', nonce: RECORD_LIMIT - 1 }],
  ])('%s', async (_what, nonce, fairness) => {
    expect((await result(await fairnessRig(nonce, null), AUTHENTICATE))['fairness']).toStrictEqual(fairness);
  });

  it('секрет испорчен — в карантин; новый секрет с тем же обязательством (сломанная энтропия) пишется поверх, а не вечный INTERNAL', async () => {
    const broken = { commitment: C0, secret: 'zz', createdAt: T0, revealedAt: null };
    const storage = new MemoryStorage({ durable: true });
    await plant(storage, [
      { op: 'put', store: 'fairness', value: { id: 'main', commitment: C0, clientSeed: 'Mine', nonce: 4 } },
      { op: 'put', store: 'secrets', value: broken },
    ]);
    const rig = new Rig({ storage, rounds: { kind: 'book', loader: new ScriptedBookLoader() } });
    expect((await result(rig, AUTHENTICATE))['fairness']).toStrictEqual({ commitment: C0, clientSeed: 'Mine', nonce: 0 });
    const snapshot = storage.snapshot();
    expect(snapshot.quarantine).toStrictEqual([[1, { store: 'secrets', raw: broken, reason: 'секрет: обязательство или секрет — не 64 знака hex', at: T0 }]]);
    expect(snapshot.secrets).toStrictEqual([[C0, { commitment: C0, secret: X0, createdAt: T0, revealedAt: null }]]);
  });

  it('энтропия дала секрет короче 32 байт — свой же гард не пускает запись: INTERNAL, ничего не записано', async () => {
    const storage = new MemoryStorage({ durable: true });
    const server = new RgsServer(
      { storage, lock: new MemoryLock(), clock: new FixedClock(T0), entropy: new ShortBytes([]), broadcast: new BroadcastLog(storage), crypto: new NodeCrypto() },
      { config: DEFAULT_CONFIG, rounds: { kind: 'book', loader: new ScriptedBookLoader() } },
    );
    expect((await server.handle({ v: 1, id: 1, body: AUTHENTICATE })).body).toStrictEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'запись отвергнута своим же гардом: секрет: обязательство или секрет — не 64 знака hex' },
    });
    expect(storage.snapshot()).toStrictEqual({ wallet: [], rounds: [], keys: [], quarantine: [], fairness: [], secrets: [] });
  });

  it('у раунда книги испорчены события — пересчёт по сиду; происхождение и поля честности остаются его', async () => {
    const storage = new MemoryStorage({ durable: true });
    const bookRound = { ...HISTORY_ROUND, roundId: 'r7', seq: 7, idempotencyKey: 'k7', status: 'active', balanceAfterEnd: null, source: 'book', bookIndex: 1, nonce: 3, commitment: C1, clientSeed: 'Mine' };
    await plant(storage, [
      { op: 'put', store: 'wallet', value: { id: 'main', balanceMinor: 99_900, activeRoundId: 'r7', nextSeq: 8, revision: 12, resetSeq: 1 } },
      { op: 'put', store: 'rounds', value: { ...bookRound, events: null } },
      { op: 'put', store: 'keys', value: { key: 'k7', roundId: 'r7', betMinor: 100 } },
    ]);
    const rig = new Rig({ storage, rounds: { kind: 'book', loader: new ScriptedBookLoader() } });
    const active = (await result(rig, AUTHENTICATE))['activeRound'] as Record<string, unknown>;
    expect([active['source'], active['bookIndex'], active['nonce'], active['events']]).toStrictEqual(['book', 1, 3, fixtureRound('small-win').events]);
    await result(rig, endRound('r7'));
    expect(storage.snapshot().rounds).toStrictEqual([['r7', { ...bookRound, status: 'closed', balanceAfterEnd: 99_995 }]]);
  });
});

/** Энтропия со сломанными байтами: на один меньше, чем просят. */
class ShortBytes extends ScriptedEntropy {
  override bytes(length: number): Uint8Array {
    return super.bytes(length).subarray(0, length - 1);
  }
}
