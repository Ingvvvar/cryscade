import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { RECORD_LIMIT, RESUME_LIMIT } from '../../../src/server/records.ts';
import { MemoryStorage, type CommitBatch, type CommitOutcome, type Storage, type WriteOp } from '../../../src/server/index.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';
import { FixedClock, Rig, T0, plant } from '../../support/rgs-rig.ts';
import { verifyRound } from '../../support/round-model.ts';

// Испорченное хранилище (§6.6): лечение по сиду, починка со сбросом до 1000 и карантином, испорченный ключ,
// испорченная история. Состояние готовится записью мимо сервера.

const SMALL = fixtureRound('small-win');
const BASE = fixtureRound('base-win');

const AUTHENTICATE = { type: 'authenticate' };
const EARLIER = T0 - 60_000;

type Fields = Readonly<Record<string, unknown>>;

const wallet = (over: Fields = {}): Fields => ({
  id: 'main',
  balanceMinor: 99_900,
  activeRoundId: 'r7',
  nextSeq: 8,
  revision: 12,
  resetSeq: 1,
  ...over,
});

/** Активный раунд 7: small-win, сид 0, ставка 100 → выигрыш 95. */
const active = (over: Fields = {}): Fields => ({
  roundId: 'r7',
  seq: 7,
  idempotencyKey: 'k7',
  betMinor: 100,
  seed: 0,
  payX100: 95,
  winMinor: 95,
  events: SMALL.events,
  createdAt: EARLIER,
  status: 'active',
  balanceAfterBet: 99_900,
  balanceAfterEnd: null,
  ...over,
});

/** Закрытый раунд 6: base-win, сид 2, ставка 100 → выигрыш 190. */
const closed = (over: Fields = {}): Fields => ({
  roundId: 'r6',
  seq: 6,
  idempotencyKey: 'k6',
  betMinor: 100,
  seed: 2,
  payX100: 190,
  winMinor: 190,
  events: BASE.events,
  createdAt: EARLIER,
  status: 'closed',
  balanceAfterBet: 99_810,
  balanceAfterEnd: 100_000,
  ...over,
});

const key = (name: string, roundId: string): Fields => ({ key: name, roundId, betMinor: 100 });

/** Кошелёк, активный r7 с ключом k7, закрытый r6 с ключом k6 — с заменами. */
async function planted(replace: { wallet?: Fields | null; active?: Fields | null; closed?: Fields; keys?: Fields[] } = {}): Promise<MemoryStorage> {
  const storage = new MemoryStorage({ durable: true });
  const ops: WriteOp[] = [];
  const walletValue = replace.wallet === undefined ? wallet() : replace.wallet;
  if (walletValue !== null) ops.push({ op: 'put', store: 'wallet', value: walletValue });
  const activeValue = replace.active === undefined ? active() : replace.active;
  if (activeValue !== null) ops.push({ op: 'put', store: 'rounds', value: activeValue });
  ops.push({ op: 'put', store: 'rounds', value: replace.closed ?? closed() });
  for (const value of replace.keys ?? [key('k6', 'r6'), key('k7', 'r7')]) ops.push({ op: 'put', store: 'keys', value });
  await plant(storage, ops);
  return storage;
}

const REPAIRED = (revision: number, nextSeq = 8): Fields => ({
  id: 'main',
  balanceMinor: 100_000,
  activeRoundId: null,
  nextSeq,
  revision,
  resetSeq: nextSeq,
});

const RESET_NOTICE = (revision: number): Fields => ({
  v: 1,
  type: 'walletChanged',
  balanceMinor: 100_000,
  activeRoundId: null,
  revision,
  notice: 'reset',
});

async function authenticated(rig: Rig): Promise<Fields> {
  const response = await rig.send(AUTHENTICATE);
  if (!response.ok) throw new Error(`authenticate: ${response.error.code}`);
  return response.result as Fields;
}

describe('лечение по сиду', () => {
  it('испорчены только события активного раунда — пересчёт движком, раунд продолжается, без записи и полосы', async () => {
    const storage = await planted({ active: active({ events: 'испорчено' }) });
    const before = storage.snapshot();
    const rig = new Rig({ storage });
    const result = await authenticated(rig);
    expect(result['activeRound']).toStrictEqual({ roundId: 'r7', betMinor: 100, payX100: 95, winMinor: 95, events: SMALL.events, source: 'live', bookIndex: null, nonce: null });
    expect([result['balanceMinor'], result['notice']]).toStrictEqual([99_900, null]);
    expect(storage.snapshot()).toStrictEqual(before);
    expect(rig.broadcast.messages).toStrictEqual([]);

    // Закрытая запись несёт уже пересчитанные события.
    expect(await rig.send({ type: 'endRound', roundId: 'r7' })).toStrictEqual({
      ok: true,
      result: { balanceMinor: 99_995, wallet: { balanceMinor: 99_995, revision: 13, notice: null } },
    });
    expect(await storage.get('rounds', 'r7')).toStrictEqual(active({ status: 'closed', balanceAfterEnd: 99_995 }));
  });

  it('повтор play с ключом раунда, чьи события испорчены, — тот же раунд с пересчитанными событиями', async () => {
    const rig = new Rig({ storage: await planted({ active: active({ events: [{ t: 'fill' }] }) }) });
    expect(await rig.send({ type: 'play', betMinor: 100, idempotencyKey: 'k7' })).toStrictEqual({
      ok: true,
      result: {
        round: { roundId: 'r7', betMinor: 100, payX100: 95, winMinor: 95, events: SMALL.events, source: 'live', bookIndex: null, nonce: null },
        balanceMinor: 99_900,
        wallet: { balanceMinor: 99_900, revision: 12, notice: null },
      },
    });
  });

  it.each([
    ['итог не тот, что даёт сид', { payX100: 36, winMinor: 36 }],
    ['выигрыш не тот, что даёт итог', { winMinor: 36 }],
  ])('события испорчены, %s — не лечится: починка', async (_what, money) => {
    const storage = await planted({ active: active({ events: 'испорчено', ...money }) });
    const rig = new Rig({ storage });
    const result = await authenticated(rig);
    expect([result['balanceMinor'], result['activeRound'], result['notice']]).toStrictEqual([100_000, null, 'reset']);
    expect(storage.snapshot().quarantine).toStrictEqual([
      [1, { store: 'rounds', raw: active({ events: 'испорчено', ...money }), reason: 'раунд: события — не непустой массив', at: T0 }],
    ]);
  });

  it('сторож на пересчёте — не лечится: починка, а не зависание', async () => {
    const storage = await planted({ active: active({ events: 'испорчено' }) });
    const rig = new Rig({ storage, maxRequests: 50 });
    const result = await authenticated(rig);
    expect([result['balanceMinor'], result['notice']]).toStrictEqual([100_000, 'reset']);
  });
});

describe('починка: сброс до 1000, карантин, полоса', () => {
  it('испорчен кошелёк — он и незакрытый последний раунд в карантин, раунд снят с ключами, закрытые на месте', async () => {
    const damaged = wallet({ balanceMinor: '99900' });
    const storage = await planted({ wallet: damaged });
    const rig = new Rig({ storage });
    const result = await authenticated(rig);
    expect([result['balanceMinor'], result['activeRound'], result['notice']]).toStrictEqual([100_000, null, 'reset']);
    expect(result['wallet']).toStrictEqual({ balanceMinor: 100_000, revision: 13, notice: 'reset' });
    const reason = 'кошелёк: balanceMinor — не целое до 2^52';
    expect(storage.snapshot()).toStrictEqual({
      wallet: [['main', REPAIRED(13)]],
      rounds: [['r6', closed()]],
      keys: [['k6', key('k6', 'r6')]],
      quarantine: [
        [1, { store: 'wallet', raw: damaged, reason, at: T0 }],
        [2, { store: 'rounds', raw: active(), reason, at: T0 }],
      ],
      fairness: [],
      secrets: [],
    });
    expect(rig.broadcast.messages).toStrictEqual([RESET_NOTICE(13)]);
  });

  it('кошелька нет, а раунды есть; последний закрыт — остаётся, счёт seq продолжается', async () => {
    const storage = await planted({ wallet: null, active: null, keys: [key('k6', 'r6')] });
    const rig = new Rig({ storage });
    const result = await authenticated(rig);
    expect([result['balanceMinor'], result['notice']]).toStrictEqual([100_000, 'reset']);
    // Ревизия началась заново — поэтому reset в кошельке ответа: клиент примет его без сравнения.
    expect(result['wallet']).toStrictEqual({ balanceMinor: 100_000, revision: 1, notice: 'reset' });
    expect(storage.snapshot()).toStrictEqual({
      wallet: [['main', REPAIRED(1, 7)]],
      rounds: [['r6', closed()]],
      keys: [['k6', key('k6', 'r6')]],
      quarantine: [],
      fairness: [],
      secrets: [],
    });
  });

  it('кошелька нет, последний раунд активен — ставка без кошелька ничья: раунд снят', async () => {
    const storage = await planted({ wallet: null });
    const rig = new Rig({ storage });
    await authenticated(rig);
    const snapshot = storage.snapshot();
    expect(snapshot.rounds.map(([id]) => id)).toStrictEqual(['r6']);
    expect(snapshot.keys.map(([name]) => name)).toStrictEqual(['k6']);
    expect(snapshot.quarantine).toStrictEqual([[1, { store: 'rounds', raw: active(), reason: 'кошелька нет, а раунды есть', at: T0 }]]);
    expect(snapshot.wallet).toStrictEqual([['main', REPAIRED(1)]]);
  });

  it('nextSeq кошелька позади раундов — починка, счёт seq — после последнего раунда', async () => {
    const storage = await planted({ wallet: wallet({ activeRoundId: null, balanceMinor: 100_000, nextSeq: 5 }), active: null });
    const rig = new Rig({ storage });
    const result = await authenticated(rig);
    expect(result['notice']).toBe('reset');
    expect(storage.snapshot().wallet).toStrictEqual([['main', REPAIRED(13, 7)]]);
  });

  it.each([
    ['сердцевина раунда испорчена', { seed: -1 }, 'раунд: сид — не u32'],
    ['ставка раунда не сходится с кошельком', { balanceAfterBet: 99_800 }, 'активный раунд не сходится с кошельком'],
    ['кошелёк указывает на закрытый раунд', { status: 'closed', balanceAfterEnd: 99_995 }, 'активный раунд не сходится с кошельком'],
    ['выигрыш цельного раунда не тот, что даёт итог', { winMinor: 3500 }, 'активный раунд не сходится с кошельком'],
  ])('%s — раунд в карантин и снят с ключами, 1000', async (_what, over, reason) => {
    const storage = await planted({ active: active(over) });
    const rig = new Rig({ storage });
    const result = await authenticated(rig);
    expect([result['balanceMinor'], result['activeRound'], result['notice']]).toStrictEqual([100_000, null, 'reset']);
    expect(storage.snapshot()).toStrictEqual({
      wallet: [['main', REPAIRED(13)]],
      rounds: [['r6', closed()]],
      keys: [['k6', key('k6', 'r6')]],
      quarantine: [[1, { store: 'rounds', raw: active(over), reason, at: T0 }]],
      fairness: [],
      secrets: [],
    });
  });

  it('кошелёк указывает на раунд, которого нет, — починка, карантину нечего копировать; счёт — от годного seq 6', async () => {
    const storage = await planted({ active: null, keys: [key('k6', 'r6'), key('k7', 'r7')] });
    const rig = new Rig({ storage });
    await authenticated(rig);
    expect(storage.snapshot()).toStrictEqual({
      wallet: [['main', REPAIRED(13, 7)]],
      rounds: [['r6', closed()]],
      keys: [['k6', key('k6', 'r6')]],
      quarantine: [],
      fairness: [],
      secrets: [],
    });
  });

  it('починка посреди play: сначала сброс, потом ставка с нового баланса', async () => {
    const storage = await planted({ wallet: wallet({ revision: 'x' }) });
    const rig = new Rig({ storage, seeds: [1] });
    expect(await rig.send({ type: 'play', betMinor: 1000, idempotencyKey: 'k8' })).toStrictEqual({
      ok: true,
      result: {
        round: { roundId: 'r1', betMinor: 1000, payX100: 0, winMinor: 0, events: fixtureRound('loss').events, source: 'live', bookIndex: null, nonce: null },
        balanceMinor: 99_000,
        // Починка — в этом же запросе: у play нет своего уведомления, о сбросе говорит кошелёк ответа.
        wallet: { balanceMinor: 99_000, revision: 2, notice: 'reset' },
      },
    });
    expect(rig.broadcast.messages.map((message) => [message.revision, message.notice])).toStrictEqual([
      [1, 'reset'],
      [2, null],
    ]);
    expect(storage.snapshot().wallet).toStrictEqual([
      ['main', { id: 'main', balanceMinor: 99_000, activeRoundId: 'r1', nextSeq: 9, revision: 2, resetSeq: 8 }],
    ]);
  });

  it('счётчик за границей 2^52 — кошелёк испорчен: починка, и дальше играется', async () => {
    const storage = await planted({ wallet: wallet({ nextSeq: Number.MAX_SAFE_INTEGER }), active: null, keys: [key('k6', 'r6')] });
    const rig = new Rig({ storage, seeds: [1] });
    const played = await rig.send({ type: 'play', betMinor: 20, idempotencyKey: 'k8' });
    expect(played.ok).toBe(true);
    expect(storage.snapshot().wallet).toStrictEqual([
      ['main', { id: 'main', balanceMinor: 99_980, activeRoundId: 'r1', nextSeq: 8, revision: 14, resetSeq: 7 }],
    ]);
  });

  it('сервер не пишет того, что сам отвергнет: часы с дробным временем — INTERNAL, записи нет', async () => {
    const storage = await planted({ wallet: wallet({ activeRoundId: null, balanceMinor: 100_000 }), active: null });
    const before = storage.snapshot();
    const rig = new Rig({ storage, seeds: [1], clock: new FixedClock(T0 + 0.5) });
    expect(await rig.send({ type: 'play', betMinor: 20, idempotencyKey: 'k8' })).toStrictEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'запись отвергнута своим же гардом: раунд: createdAt — не целое' },
    });
    expect(storage.snapshot()).toStrictEqual(before);
    expect(rig.broadcast.messages).toStrictEqual([]);
  });

  it('другая вкладка починила раньше: устаревшая починка не пишет поверх, ответ — по свежему кошельку', async () => {
    const storage = await planted({ wallet: wallet({ balanceMinor: -1 }) });
    const fixed = { id: 'main', balanceMinor: 100_000, activeRoundId: null, nextSeq: 8, revision: 13, resetSeq: 8 };
    const rig = new Rig({ storage, wrap: (inner) => new FixedBeforeFirstCommit(inner, fixed) });
    const result = await authenticated(rig);
    expect([result['balanceMinor'], result['notice']]).toStrictEqual([100_000, null]);
    expect(storage.snapshot().quarantine).toStrictEqual([]);
    expect(storage.snapshot().wallet).toStrictEqual([['main', fixed]]);
    expect(rig.broadcast.messages).toStrictEqual([]);
  });
});

/** Перед первой записью сервера другая вкладка успевает положить починенный кошелёк и снять раунды. */
class FixedBeforeFirstCommit implements Storage {
  readonly durable = true;
  readonly #inner: MemoryStorage;
  readonly #fixed: Fields;
  #done = false;

  constructor(inner: MemoryStorage, fixed: Fields) {
    this.#inner = inner;
    this.#fixed = fixed;
  }

  get(...args: Parameters<Storage['get']>): ReturnType<Storage['get']> {
    return this.#inner.get(...args);
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

  async commit(batch: CommitBatch): Promise<CommitOutcome> {
    if (!this.#done) {
      this.#done = true;
      await plant(this.#inner, [
        { op: 'put', store: 'wallet', value: this.#fixed },
        { op: 'delete', store: 'rounds', key: 'r7' },
        { op: 'delete', store: 'keys', key: 'k7' },
      ]);
    }
    return this.#inner.commit(batch);
  }
}

describe('испорченная запись ключа', () => {
  const damagedKey = { key: 'k7', roundId: 7 };

  it('раунд с этим ключом хранится — повтор отдаёт его, а не ROUND_ACTIVE', async () => {
    const storage = await planted({ keys: [key('k6', 'r6'), damagedKey] });
    const before = storage.snapshot();
    const rig = new Rig({ storage });
    expect(await rig.send({ type: 'play', betMinor: 100, idempotencyKey: 'k7' })).toStrictEqual({
      ok: true,
      result: {
        round: { roundId: 'r7', betMinor: 100, payX100: 95, winMinor: 95, events: SMALL.events, source: 'live', bookIndex: null, nonce: null },
        balanceMinor: 99_900,
        wallet: { balanceMinor: 99_900, revision: 12, notice: null },
      },
    });
    expect(storage.snapshot()).toStrictEqual(before);
  });

  it('раунд с этим ключом хранится, ставка другая — IDEMPOTENCY_CONFLICT', async () => {
    const rig = new Rig({ storage: await planted({ keys: [key('k6', 'r6'), damagedKey] }) });
    expect(await rig.send({ type: 'play', betMinor: 200, idempotencyKey: 'k7' })).toStrictEqual({
      ok: false,
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('цельная запись ключа указывает на чужой раунд — ROUND_NOT_FOUND: чужой раунд повтору не отдаётся', async () => {
    const storage = await planted({ keys: [key('k6', 'r6'), key('k7', 'r7'), key('k9', 'r6')] });
    const before = storage.snapshot();
    const rig = new Rig({ storage });
    expect(await rig.send({ type: 'play', betMinor: 100, idempotencyKey: 'k9' })).toStrictEqual({
      ok: false,
      error: { code: 'ROUND_NOT_FOUND', roundId: 'r6' },
    });
    expect(storage.snapshot()).toStrictEqual(before);
  });

  it('цельная запись ключа, а раунда нет — ROUND_NOT_FOUND, без списания', async () => {
    const storage = await planted({
      wallet: wallet({ activeRoundId: null, balanceMinor: 100_000 }),
      active: null,
      keys: [key('k6', 'r6'), key('k7', 'r7')],
    });
    const before = storage.snapshot();
    const rig = new Rig({ storage, seeds: [1] });
    expect(await rig.send({ type: 'play', betMinor: 100, idempotencyKey: 'k7' })).toStrictEqual({
      ok: false,
      error: { code: 'ROUND_NOT_FOUND', roundId: 'r7' },
    });
    expect(storage.snapshot()).toStrictEqual(before);
  });

  it('своего раунда нет — запись ключа в карантин, на её место новая, раунд играется', async () => {
    const storage = await planted({
      wallet: wallet({ activeRoundId: null, balanceMinor: 100_000 }),
      active: null,
      keys: [key('k6', 'r6'), { key: 'kx' }],
    });
    const rig = new Rig({ storage, seeds: [1] });
    const response = await rig.send({ type: 'play', betMinor: 100, idempotencyKey: 'kx' });
    expect(response.ok).toBe(true);
    const snapshot = storage.snapshot();
    expect(snapshot.keys).toStrictEqual([
      ['k6', key('k6', 'r6')],
      ['kx', { key: 'kx', roundId: 'r1', betMinor: 100 }],
    ]);
    expect(snapshot.quarantine).toStrictEqual([[1, { store: 'keys', raw: { key: 'kx' }, reason: 'ключ: key или roundId — не id', at: T0 }]]);
  });
});

describe('испорченная история', () => {
  it('у закрытого раунда ставка × итог вне точных целых — раунд испорчен: сетка покоя его пропускает, ответ есть', async () => {
    const storage = await planted({
      wallet: wallet({ activeRoundId: null, balanceMinor: 100_000 }),
      active: { ...closed({ roundId: 'r7', seq: 7, idempotencyKey: 'k7' }), betMinor: 47_406_311_867_058 },
    });
    const rig = new Rig({ storage });
    const result = await authenticated(rig);
    expect(result['idleGrid']).toStrictEqual(verifyRound(DEFAULT_CONFIG, BASE.events).finalGrid);
  });

  it('раунд с seq за границей 2^52 для индекса невидим: не сдвигает счёт и не мешает играть', async () => {
    const storage = await planted({
      wallet: wallet({ activeRoundId: null, balanceMinor: 100_000 }),
      active: { ...closed({ roundId: 'r7', idempotencyKey: 'k7' }), seq: Number.MAX_SAFE_INTEGER },
    });
    const rig = new Rig({ storage, seeds: [1] });
    const result = await authenticated(rig);
    expect([result['balanceMinor'], result['notice']]).toStrictEqual([100_000, null]);
    expect(await rig.send({ type: 'play', betMinor: 20, idempotencyKey: 'k8' })).toMatchObject({ ok: true, result: { balanceMinor: 99_980 } });
    expect(storage.snapshot().wallet).toStrictEqual([
      ['main', { id: 'main', balanceMinor: 99_980, activeRoundId: 'r1', nextSeq: 9, revision: 13, resetSeq: 1 }],
    ]);
  });

  it('сетка покоя пропускает испорченный последний раунд и берёт предыдущий закрытый', async () => {
    const broken = { ...closed({ roundId: 'r7', seq: 7, idempotencyKey: 'k7' }), seed: 'x' };
    const storage = await planted({ wallet: wallet({ activeRoundId: null, balanceMinor: 100_000 }), active: broken });
    const rig = new Rig({ storage });
    const result = await authenticated(rig);
    expect(result['idleGrid']).toStrictEqual(verifyRound(DEFAULT_CONFIG, BASE.events).finalGrid);
    expect(result['notice']).toBeNull();
  });

  it('повтор endRound закрытого раунда с испорченными событиями — сохранённый баланс по цельной части', async () => {
    const storage = await planted({
      wallet: wallet({ activeRoundId: null, balanceMinor: 100_000 }),
      active: null,
      closed: closed({ events: null }),
    });
    const rig = new Rig({ storage });
    expect(await rig.send({ type: 'endRound', roundId: 'r6' })).toStrictEqual({
      ok: true,
      result: { balanceMinor: 100_000, wallet: { balanceMinor: 100_000, revision: 12, notice: null } },
    });
  });
});

/** Хранилище из записей как есть: кошелёк (или его нет), раунды, ключи. */
async function storageOf(walletValue: Fields | null, rounds: readonly Fields[], keys: readonly Fields[] = []): Promise<MemoryStorage> {
  const storage = new MemoryStorage({ durable: true });
  const ops: WriteOp[] = [];
  if (walletValue !== null) ops.push({ op: 'put', store: 'wallet', value: walletValue });
  for (const value of rounds) ops.push({ op: 'put', store: 'rounds', value });
  for (const value of keys) ops.push({ op: 'put', store: 'keys', value });
  await plant(storage, ops);
  return storage;
}

/** n спинов по 20 без выигрыша (сид 1 — проигрыш): все ответы — ok. Ключи — s1, s2, … */
async function spins(rig: Rig, n: number): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (let i = 1; i <= n; i++) {
    const played = await rig.send({ type: 'play', betMinor: 20, idempotencyKey: `s${String(i)}` });
    if (!played.ok) {
      failures.push([i, 'play', played.error]);
      continue;
    }
    const ended = await rig.send({ type: 'endRound', roundId: (played.result as { round: { roundId: string } }).round.roundId });
    if (!ended.ok) failures.push([i, 'endRound', ended.error]);
  }
  return failures;
}

const LOSSES = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

/** Закрытый раунд 6 под другим id: id раундов стенда — r1, r2, …, и r6 стенда не должен наступить на него. */
const OLD6 = closed({ roundId: 'old6', idempotencyKey: 'q6' });

describe('дробный seq и испорченный верх индекса', () => {
  it('контрпример fast-check (storage-damage, сид 1622746427): кошелька нет, у активного r7 seq 1.0000000000000004', async () => {
    const broken = active({ seq: 1.0000000000000004, createdAt: T0 });
    const storage = await storageOf(null, [broken]);
    const rig = new Rig({ storage, seeds: LOSSES });
    expect(await rig.send({ type: 'endRound', roundId: 'r6' })).toStrictEqual({ ok: false, error: { code: 'ROUND_NOT_FOUND', roundId: 'r6' } });
    expect(storage.snapshot()).toStrictEqual({
      wallet: [['main', REPAIRED(1, 1)]],
      rounds: [],
      keys: [],
      quarantine: [[1, { store: 'rounds', raw: broken, reason: 'кошелька нет, а раунды есть', at: T0 }]],
      fairness: [],
      secrets: [],
    });
    expect(await spins(rig, 3)).toStrictEqual([]);
  });

  it.each([
    ['7.5', 7.5],
    ['6.5 — сразу над годным', 6.5],
    ['2^53', 2 ** 53],
    ['1e300', 1e300],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['2^52 + 1 за границей записей', 2 ** 52 + 1],
    ['строка', '7'],
    ['дата', new Date(0)],
    ['массив', [7]],
    ['двоичные', new Uint8Array([7])],
  ])('ловушка: испорченный верх %s над годным seq 6 — верх в карантин с ключами, nextSeq 7, шесть спинов без INTERNAL', async (_what, seq) => {
    const top = active({ seq });
    const storage = await storageOf(null, [OLD6, top], [key('q6', 'old6'), key('k7', 'r7')]);
    const rig = new Rig({ storage, seeds: LOSSES });
    const result = await authenticated(rig);
    expect([result['balanceMinor'], result['notice']]).toStrictEqual([100_000, 'reset']);
    const repaired = storage.snapshot();
    expect(repaired.wallet).toStrictEqual([['main', REPAIRED(1, 7)]]);
    expect(repaired.rounds.map(([id]) => id)).toStrictEqual(['old6']);
    expect(repaired.keys.map(([name]) => name)).toStrictEqual(['q6']);
    expect(repaired.quarantine).toStrictEqual([[1, { store: 'rounds', raw: top, reason: 'кошелька нет, а раунды есть', at: T0 }]]);
    expect(await spins(rig, 6)).toStrictEqual([]);
    expect(storage.snapshot().wallet).toStrictEqual([['main', { id: 'main', balanceMinor: 99_880, activeRoundId: null, nextSeq: 13, revision: 13, resetSeq: 7 }]]);
  });

  it('весь мусор выше годного — в карантин, сверху вниз; дробный ниже годного остаётся: столкнуться ему не с чем', async () => {
    const low = { ...closed({ roundId: 'low', idempotencyKey: 'ql' }), seq: 3.5 };
    const tops = [
      { ...active(), roundId: 'ta', seq: [1] },
      { ...active(), roundId: 'ts', seq: 'x' },
      { ...active(), roundId: 'tn', seq: 2 ** 53 },
    ];
    const storage = await storageOf(wallet({ balanceMinor: '1' }), [low, OLD6, ...tops]);
    const rig = new Rig({ storage, seeds: LOSSES });
    await authenticated(rig);
    const snapshot = storage.snapshot();
    expect(snapshot.quarantine.map(([, entry]) => (entry as { raw: { roundId?: string } }).raw.roundId ?? 'кошелёк')).toStrictEqual([
      'кошелёк',
      'ta',
      'ts',
      'tn',
    ]);
    expect(snapshot.rounds.map(([id]) => id)).toStrictEqual(['low', 'old6']);
    expect(snapshot.wallet).toStrictEqual([['main', REPAIRED(13, 7)]]);
  });

  it('активный раунд кошелька с испорченным seq выше годного — в карантин один раз', async () => {
    const top = active({ seq: 7.5 });
    const storage = await storageOf(wallet(), [OLD6, top], [key('q6', 'old6'), key('k7', 'r7')]);
    const rig = new Rig({ storage, seeds: LOSSES });
    await authenticated(rig);
    const reason = 'раунд: seq или betMinor — не положительные целые до 2^52';
    expect(storage.snapshot().quarantine).toStrictEqual([[1, { store: 'rounds', raw: top, reason, at: T0 }]]);
    expect(storage.snapshot().wallet).toStrictEqual([['main', REPAIRED(13, 7)]]);
  });

  it('годных нет — счёт с единицы, в карантин уходит весь индекс', async () => {
    const tops = [
      { ...active(), roundId: 'ta', seq: 0 },
      { ...active(), roundId: 'tb', seq: -5 },
      { ...active(), roundId: 'tc', seq: 'z' },
    ];
    const storage = await storageOf(null, tops);
    const rig = new Rig({ storage, seeds: LOSSES });
    await authenticated(rig);
    expect(storage.snapshot()).toMatchObject({ wallet: [['main', REPAIRED(1, 1)]], rounds: [] });
    expect(storage.snapshot().quarantine).toHaveLength(3);
    expect(await spins(rig, 2)).toStrictEqual([]);
  });

  it('seq, который не ключ (NaN), индексу не виден: кошелька нет — новый кошелёк без починки', async () => {
    const storage = await storageOf(null, [{ ...active(), seq: Number.NaN }]);
    const rig = new Rig({ storage, seeds: LOSSES });
    const result = await authenticated(rig);
    expect(result['notice']).toBeNull();
    expect(storage.snapshot().quarantine).toStrictEqual([]);
  });

  it('годный — не выше 2^51: раунд на 2^51 годен, раунд на 2^51 + 1 уходит в карантин', async () => {
    const at = (roundId: string, seq: number): Fields => closed({ roundId, idempotencyKey: `q${roundId}`, seq });
    const storage = await storageOf(wallet({ balanceMinor: -1 }), [OLD6, at('edge', RESUME_LIMIT), at('over', RESUME_LIMIT + 1)]);
    const rig = new Rig({ storage, seeds: LOSSES });
    await authenticated(rig);
    const snapshot = storage.snapshot();
    expect(snapshot.rounds.map(([id]) => id)).toStrictEqual(['edge', 'old6']);
    expect(snapshot.wallet).toStrictEqual([['main', REPAIRED(13, RESUME_LIMIT + 1)]]);
    expect(await spins(rig, 2)).toStrictEqual([]);
  });
});

describe('согласованность кошелька с индексом', () => {
  it('раунд с seq впереди nextSeq — починка, счёт после него', async () => {
    const ahead = closed({ roundId: 'ahead', idempotencyKey: 'qa', seq: 9 });
    const storage = await storageOf(wallet({ activeRoundId: null, balanceMinor: 100_000 }), [OLD6, ahead]);
    const rig = new Rig({ storage, seeds: LOSSES });
    expect((await authenticated(rig))['notice']).toBe('reset');
    expect(storage.snapshot().wallet).toStrictEqual([['main', REPAIRED(13, 10)]]);
    expect(await spins(rig, 2)).toStrictEqual([]);
  });

  it('раунд впереди nextSeq выше границы продолжения — тоже столкновение: починка раньше, чем спин на него наступит', async () => {
    const ahead = closed({ roundId: 'ahead', idempotencyKey: 'qa', seq: RESUME_LIMIT + 3 });
    const storage = await storageOf(wallet({ activeRoundId: null, balanceMinor: 100_000, nextSeq: RESUME_LIMIT + 1 }), [OLD6, ahead]);
    const rig = new Rig({ storage, seeds: LOSSES });
    expect(await spins(rig, 3)).toStrictEqual([]);
    const snapshot = storage.snapshot();
    expect(snapshot.quarantine.map(([, entry]) => (entry as { raw: { roundId: string } }).raw.roundId)).toStrictEqual(['ahead']);
    expect(snapshot.wallet).toStrictEqual([['main', { id: 'main', balanceMinor: 99_940, activeRoundId: null, nextSeq: 10, revision: 19, resetSeq: 7 }]]);
  });
});

describe('запас до границы записей (2^52)', () => {
  const idle = (over: Fields): Fields => wallet({ activeRoundId: null, balanceMinor: 100_000, ...over });

  it.each([
    ['nextSeq на самой границе', { nextSeq: RECORD_LIMIT }],
    ['revision: не хватает на две записи спина', { revision: RECORD_LIMIT - 1 }],
    ['баланс: наибольший выигрыш (100 × 5000 = 50 000 000) выведет за границу', { balanceMinor: RECORD_LIMIT - 50_000_000 + 1 }],
  ])('%s — починка до спина, и дальше играется', async (_what, over) => {
    const storage = await storageOf(idle(over), [OLD6]);
    const rig = new Rig({ storage, seeds: LOSSES });
    expect(await spins(rig, 3)).toStrictEqual([]);
    expect(rig.broadcast.messages.filter((message) => message.notice === 'reset')).toHaveLength(1);
    expect(storage.snapshot().wallet[0]?.[1]).toMatchObject({ balanceMinor: 99_940, nextSeq: 10, resetSeq: 7 });
  });

  it.each([
    ['nextSeq: место ровно на один раунд', { nextSeq: RECORD_LIMIT - 1 }, { nextSeq: RECORD_LIMIT }],
    ['revision: ровно две записи', { revision: RECORD_LIMIT - 2 }, { revision: RECORD_LIMIT }],
    ['баланс: ровно наибольший выигрыш', { balanceMinor: RECORD_LIMIT - 50_000_000 }, { balanceMinor: RECORD_LIMIT - 50_000_000 - 20 }],
  ])('%s — спин без починки', async (_what, over, after) => {
    const storage = await storageOf(idle(over), [OLD6]);
    const rig = new Rig({ storage, seeds: LOSSES });
    expect(await spins(rig, 1)).toStrictEqual([]);
    expect(rig.broadcast.messages.map((message) => message.notice)).toStrictEqual([null, null]);
    expect(storage.snapshot().wallet[0]?.[1]).toMatchObject(after);
  });

  it('ревизия выше 2^51 при починке начинается заново', async () => {
    const storage = await storageOf(idle({ revision: RECORD_LIMIT }), [OLD6]);
    const rig = new Rig({ storage, seeds: LOSSES });
    const result = await authenticated(rig);
    expect(result['wallet']).toStrictEqual({ balanceMinor: 100_000, revision: 1, notice: 'reset' });
  });

  it('ревизия на 2^51 при починке продолжается', async () => {
    const storage = await storageOf(wallet({ balanceMinor: 'x', revision: RESUME_LIMIT }), [OLD6]);
    const rig = new Rig({ storage, seeds: LOSSES });
    const result = await authenticated(rig);
    expect(result['wallet']).toStrictEqual({ balanceMinor: 100_000, revision: RESUME_LIMIT + 1, notice: 'reset' });
  });

  it('активный раунд не закрыть в границах — починка: раунд в карантин, 1000', async () => {
    const balance = RECORD_LIMIT - 94;
    const storage = await storageOf(wallet({ balanceMinor: balance }), [OLD6, active({ balanceAfterBet: balance })], [key('k7', 'r7')]);
    const rig = new Rig({ storage, seeds: LOSSES });
    expect(await rig.send({ type: 'endRound', roundId: 'r7' })).toStrictEqual({ ok: false, error: { code: 'ROUND_NOT_FOUND', roundId: 'r7' } });
    expect(storage.snapshot().quarantine).toStrictEqual([
      [1, { store: 'rounds', raw: active({ balanceAfterBet: balance }), reason: 'кошельку не хватает запаса до границы записей', at: T0 }],
    ]);
    expect(await spins(rig, 2)).toStrictEqual([]);
  });

  it('активный раунд закрывается ровно на границе — без починки', async () => {
    const balance = RECORD_LIMIT - 95;
    const storage = await storageOf(wallet({ balanceMinor: balance }), [OLD6, active({ balanceAfterBet: balance })], [key('k7', 'r7')]);
    const rig = new Rig({ storage, seeds: LOSSES });
    expect(await rig.send({ type: 'endRound', roundId: 'r7' })).toMatchObject({ ok: true, result: { balanceMinor: RECORD_LIMIT } });
    expect(storage.snapshot().quarantine).toStrictEqual([]);
  });
});


describe('починка: границы, гонка и владелец ключа', () => {
  const idle = wallet({ activeRoundId: null, balanceMinor: 100_000 });

  it('nextSeq кошелька равен seq раунда — уже столкновение: починка, раунд в карантин с причиной', async () => {
    const storage = await planted({ wallet: wallet({ nextSeq: 7 }) });
    const rig = new Rig({ storage });
    expect((await authenticated(rig))['notice']).toBe('reset');
    expect(storage.snapshot()).toStrictEqual({
      wallet: [['main', REPAIRED(13, 8)]],
      rounds: [['r6', closed()]],
      keys: [['k6', key('k6', 'r6')]],
      quarantine: [[1, { store: 'rounds', raw: active(), reason: 'nextSeq кошелька не впереди раундов', at: T0 }]],
      fairness: [],
      secrets: [],
    });
  });

  it('ревизия на 2^52 при активном раунде — закрытие раунда её перешло бы: починка', async () => {
    const storage = await storageOf(wallet({ revision: RECORD_LIMIT }), [OLD6, active()], [key('k7', 'r7')]);
    const rig = new Rig({ storage, seeds: LOSSES });
    const result = await authenticated(rig);
    expect([result['activeRound'], result['wallet']]).toStrictEqual([null, { balanceMinor: 100_000, revision: 1, notice: 'reset' }]);
    expect(storage.snapshot().quarantine).toStrictEqual([
      [1, { store: 'rounds', raw: active(), reason: 'кошельку не хватает запаса до границы записей', at: T0 }],
    ]);
  });

  it('мусор выше годного и активный раунд кошелька — разные записи: в карантин уходят обе', async () => {
    const stray = closed({ roundId: 'stray', idempotencyKey: 'qs', seq: RESUME_LIMIT + 1 });
    const storage = await storageOf(wallet(), [OLD6, active(), stray], [key('k7', 'r7')]);
    const rig = new Rig({ storage, seeds: LOSSES });
    await authenticated(rig);
    const snapshot = storage.snapshot();
    expect(snapshot.rounds.map(([id]) => id)).toStrictEqual(['old6']);
    expect(snapshot.keys).toStrictEqual([]);
    expect(snapshot.quarantine.map(([, entry]) => (entry as { raw: { roundId: string } }).raw.roundId)).toStrictEqual(['stray', 'r7']);
    expect(snapshot.wallet).toStrictEqual([['main', REPAIRED(13, 8)]]);
  });

  it('кошелька нет, а между чтением и починкой другая запись положила испорченный: конфликт, повтор чинит его с карантином', async () => {
    const broken = wallet({ activeRoundId: null, balanceMinor: -1, revision: 3 });
    const storage = await storageOf(null, [closed()], [key('k6', 'r6')]);
    const rig = new Rig({ storage, wrap: (inner) => new PlantBeforeFirstCommit(inner, [{ op: 'put', store: 'wallet', value: broken }]) });
    expect((await authenticated(rig))['notice']).toBe('reset');
    expect(storage.snapshot().quarantine).toStrictEqual([[1, { store: 'wallet', raw: broken, reason: 'кошелёк: balanceMinor — не целое до 2^52', at: T0 }]]);
    expect(storage.snapshot().wallet).toStrictEqual([['main', REPAIRED(4, 7)]]);
  });

  it('кошелёк-массив испорчен: ревизия починки — с нуля, из не-объекта поле не читается', async () => {
    const storage = await storageOf(Object.assign([], { id: 'main', revision: 7 }) as unknown as Fields, [OLD6]);
    const rig = new Rig({ storage, seeds: LOSSES });
    expect((await authenticated(rig))['wallet']).toStrictEqual({ balanceMinor: 100_000, revision: 1, notice: 'reset' });
  });

  it('испорчены и запись ключа, и события его раунда — владелец находится по цельной части, события пересчитаны', async () => {
    const storage = await planted({ wallet: idle, active: null, closed: closed({ events: null }), keys: [{ key: 'k6', roundId: 6 }] });
    const rig = new Rig({ storage, seeds: LOSSES });
    expect(await rig.send({ type: 'play', betMinor: 100, idempotencyKey: 'k6' })).toStrictEqual({
      ok: true,
      result: {
        round: { roundId: 'r6', betMinor: 100, payX100: 190, winMinor: 190, events: BASE.events, source: 'live', bookIndex: null, nonce: null },
        balanceMinor: 99_810,
        wallet: { balanceMinor: 100_000, revision: 12, notice: null },
      },
    });
    expect(rig.entropy.used).toBe(0);
  });

  it('записи ключа нет, а раунд с этим ключом есть — раунды не ищутся: ставка новая', async () => {
    const storage = await planted({ wallet: idle, active: null, keys: [] });
    const rig = new Rig({ storage, seeds: LOSSES });
    const played = await rig.send({ type: 'play', betMinor: 100, idempotencyKey: 'k6' });
    expect(played.ok ? (played.result as { round: { roundId: string } }).round.roundId : played.error).toBe('r1');
    expect(rig.entropy.used).toBe(1);
  });

  it('история пропускает испорченный раунд, а не падает на нём', async () => {
    const storage = await planted({ wallet: idle, active: { ...closed({ roundId: 'r7', seq: 7, idempotencyKey: 'k7' }), seed: 'x' } });
    const rig = new Rig({ storage });
    expect(await rig.send({ type: 'history', limit: 10 })).toStrictEqual({
      ok: true,
      result: {
        rounds: [
          {
            roundId: 'r6',
            createdAt: EARLIER,
            betMinor: 100,
            payX100: 190,
            winMinor: 190,
            status: 'closed',
            source: 'live',
            bookIndex: null,
            nonce: null,
            commitment: null,
            clientSeed: null,
            secret: null,
          },
        ],
      },
    });
  });

  it('повтор раунда, чьи события не пересчитать (сторож сработал), — ROUND_NOT_FOUND, а не INTERNAL', async () => {
    const storage = await planted({ wallet: idle, active: null, closed: closed({ events: null }) });
    const rig = new Rig({ storage, maxRequests: 10 });
    expect(await rig.send({ type: 'replay', round: 'r6' })).toStrictEqual({ ok: false, error: { code: 'ROUND_NOT_FOUND', roundId: 'r6' } });
  });

  it('повтор раунда, чью ставку × итог не посчитать точно, — ROUND_NOT_FOUND: раунд испорчен', async () => {
    const storage = await planted({ wallet: idle, active: { ...closed({ roundId: 'r7', seq: 7, idempotencyKey: 'k7' }), betMinor: 47_406_311_867_058 } });
    const rig = new Rig({ storage });
    expect(await rig.send({ type: 'replay', round: 'r7' })).toStrictEqual({ ok: false, error: { code: 'ROUND_NOT_FOUND', roundId: 'r7' } });
  });
});

/** Перед первой записью сервера другая вкладка успевает записать своё. */
class PlantBeforeFirstCommit implements Storage {
  readonly durable = true;
  readonly #inner: MemoryStorage;
  readonly #ops: readonly WriteOp[];
  #done = false;

  constructor(inner: MemoryStorage, ops: readonly WriteOp[]) {
    this.#inner = inner;
    this.#ops = ops;
  }

  get(...args: Parameters<Storage['get']>): ReturnType<Storage['get']> {
    return this.#inner.get(...args);
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

  async commit(batch: CommitBatch): Promise<CommitOutcome> {
    if (!this.#done) {
      this.#done = true;
      await plant(this.#inner, this.#ops);
    }
    return this.#inner.commit(batch);
  }
}
