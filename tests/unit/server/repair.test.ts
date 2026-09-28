import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { MemoryStorage, type CommitBatch, type CommitOutcome, type Storage, type WriteOp } from '../../../src/server/index.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';
import { Rig, T0, plant } from '../../support/rgs-rig.ts';
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

/** Активный раунд 7: small-win, сид 0, ставка 100 → выигрыш 35. */
const active = (over: Fields = {}): Fields => ({
  roundId: 'r7',
  seq: 7,
  idempotencyKey: 'k7',
  betMinor: 100,
  seed: 0,
  payX100: 35,
  winMinor: 35,
  events: SMALL.events,
  createdAt: EARLIER,
  status: 'active',
  balanceAfterBet: 99_900,
  balanceAfterEnd: null,
  ...over,
});

/** Закрытый раунд 6: base-win, сид 2, ставка 100 → выигрыш 105. */
const closed = (over: Fields = {}): Fields => ({
  roundId: 'r6',
  seq: 6,
  idempotencyKey: 'k6',
  betMinor: 100,
  seed: 2,
  payX100: 105,
  winMinor: 105,
  events: BASE.events,
  createdAt: EARLIER,
  status: 'closed',
  balanceAfterBet: 99_895,
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
    expect(result['activeRound']).toStrictEqual({ roundId: 'r7', betMinor: 100, payX100: 35, winMinor: 35, events: SMALL.events });
    expect([result['balanceMinor'], result['notice']]).toStrictEqual([99_900, null]);
    expect(storage.snapshot()).toStrictEqual(before);
    expect(rig.broadcast.messages).toStrictEqual([]);

    // Закрытая запись несёт уже пересчитанные события.
    expect(await rig.send({ type: 'endRound', roundId: 'r7' })).toStrictEqual({ ok: true, result: { balanceMinor: 99_935 } });
    expect(await storage.get('rounds', 'r7')).toStrictEqual(active({ status: 'closed', balanceAfterEnd: 99_935 }));
  });

  it('повтор play с ключом раунда, чьи события испорчены, — тот же раунд с пересчитанными событиями', async () => {
    const rig = new Rig({ storage: await planted({ active: active({ events: [{ t: 'fill' }] }) }) });
    expect(await rig.send({ type: 'play', betMinor: 100, idempotencyKey: 'k7' })).toStrictEqual({
      ok: true,
      result: { round: { roundId: 'r7', betMinor: 100, payX100: 35, winMinor: 35, events: SMALL.events }, balanceMinor: 99_900 },
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
    const reason = 'кошелёк: balanceMinor — не целое до 2^52';
    expect(storage.snapshot()).toStrictEqual({
      wallet: [['main', REPAIRED(13)]],
      rounds: [['r6', closed()]],
      keys: [['k6', key('k6', 'r6')]],
      quarantine: [
        [1, { store: 'wallet', raw: damaged, reason, at: T0 }],
        [2, { store: 'rounds', raw: active(), reason, at: T0 }],
      ],
    });
    expect(rig.broadcast.messages).toStrictEqual([RESET_NOTICE(13)]);
  });

  it('кошелька нет, а раунды есть; последний закрыт — остаётся, счёт seq продолжается', async () => {
    const storage = await planted({ wallet: null, active: null, keys: [key('k6', 'r6')] });
    const rig = new Rig({ storage });
    const result = await authenticated(rig);
    expect([result['balanceMinor'], result['notice']]).toStrictEqual([100_000, 'reset']);
    expect(storage.snapshot()).toStrictEqual({
      wallet: [['main', REPAIRED(1, 7)]],
      rounds: [['r6', closed()]],
      keys: [['k6', key('k6', 'r6')]],
      quarantine: [],
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
    ['кошелёк указывает на закрытый раунд', { status: 'closed', balanceAfterEnd: 99_935 }, 'активный раунд не сходится с кошельком'],
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
    });
  });

  it('кошелёк указывает на раунд, которого нет, — починка, карантину нечего копировать', async () => {
    const storage = await planted({ active: null, keys: [key('k6', 'r6'), key('k7', 'r7')] });
    const rig = new Rig({ storage });
    await authenticated(rig);
    expect(storage.snapshot()).toStrictEqual({
      wallet: [['main', REPAIRED(13)]],
      rounds: [['r6', closed()]],
      keys: [['k6', key('k6', 'r6')]],
      quarantine: [],
    });
  });

  it('починка посреди play: сначала сброс, потом ставка с нового баланса', async () => {
    const storage = await planted({ wallet: wallet({ revision: 'x' }) });
    const rig = new Rig({ storage, seeds: [1] });
    expect(await rig.send({ type: 'play', betMinor: 1000, idempotencyKey: 'k8' })).toStrictEqual({
      ok: true,
      result: { round: { roundId: 'r1', betMinor: 1000, payX100: 0, winMinor: 0, events: fixtureRound('loss').events }, balanceMinor: 99_000 },
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

  it('сервер не пишет того, что сам отвергнет: кошелёк на самой границе — INTERNAL, записи нет', async () => {
    const edge = { id: 'main', balanceMinor: 100_000, activeRoundId: null, nextSeq: 4_503_599_627_370_496, revision: 0, resetSeq: 1 };
    const storage = new MemoryStorage({ durable: true });
    await plant(storage, [{ op: 'put', store: 'wallet', value: edge }]);
    const rig = new Rig({ storage, seeds: [1] });
    expect(await rig.send({ type: 'play', betMinor: 20, idempotencyKey: 'k1' })).toStrictEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'запись отвергнута своим же гардом: кошелёк: nextSeq или resetSeq не по порядку' },
    });
    expect(storage.snapshot()).toStrictEqual({ wallet: [['main', edge]], rounds: [], keys: [], quarantine: [] });
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
      result: { round: { roundId: 'r7', betMinor: 100, payX100: 35, winMinor: 35, events: SMALL.events }, balanceMinor: 99_900 },
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
      active: { ...closed({ roundId: 'r7', seq: 7, idempotencyKey: 'k7' }), betMinor: 85_782_850_045_153 },
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
    expect(await rig.send({ type: 'endRound', roundId: 'r6' })).toStrictEqual({ ok: true, result: { balanceMinor: 100_000 } });
  });
});
