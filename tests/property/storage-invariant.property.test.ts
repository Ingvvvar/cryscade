import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseResponse, type RequestBody, type ResponseEnvelope } from '../../src/protocol/index.ts';
import { keyId, toKey } from '../../src/server/key-order.ts';
import { checkWallet } from '../../src/server/records.ts';
import { MemoryStorage, type WriteOp } from '../../src/server/index.ts';
import { fixtureRound, type FixtureName } from '../support/fixture-rounds.ts';
import { RUN_TIMEOUT_MS } from '../support/property-run.ts';
import { Rig, T0, plant } from '../support/rgs-rig.ts';

// Инвариант класса (§6.6): никакое содержимое хранилища не даёт вечного INTERNAL. Ключи seq — всех типов IndexedDB и
// не-ключи; записи годные поодиночке, но несогласованные: nextSeq не впереди раундов, активный раунд не тот, запас до
// границы записей кончился; кошелька нет или он испорчен. Клиент ведёт себя как игра: authenticate, доиграть
// активный, 10 спинов по 20 (денег нет — «Поповнити»). Условия: ни одного INTERNAL, каждый ответ проходит гард
// клиента, починок не больше одной, все спины проходят, кошелёк в хранилище цел после каждого запроса, деньги
// сходятся от последнего сброса — или от начала, если сброса не было. Выигрыш — своей формулой по итогу фикстуры.

const LIMIT = 2 ** 52;
const RESUME = 2 ** 51;
const START = 100_000;
const BET = 20;
const SPINS = 10;

const FIXTURES: readonly FixtureName[] = ['loss', 'small-win', 'base-win'];
const RECORDED = new Map(FIXTURES.map((name) => [fixtureRound(name).seed, fixtureRound(name)] as const));
/** Сиды стенда: проигрыш чаще, как в игре. */
const SEEDS = [1, 0, 2, 1, 1, 0, 1, 2, 1, 1, 0, 1];

/** Своя формула выигрыша — BigInt, мимо winMinor. */
const ownWin = (betMinor: number, payX100: number): number => Number((BigInt(betMinor) * BigInt(payX100)) / 100n);
/** seq в границах записей — своей проверкой, не гардом сервера. */
const isRecordSeq = (seq: unknown): seq is number => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 1 && seq <= LIMIT;

type SeqKind = 'целое' | 'у границ' | 'дробное' | 'за границей' | 'строка' | 'дата' | 'двоичные' | 'массив' | 'не ключ';

const SEQ: fc.Arbitrary<{ readonly kind: SeqKind; readonly seq: unknown }> = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 1, max: 12 }).map((seq) => ({ kind: 'целое' as const, seq })) },
  {
    weight: 2,
    arbitrary: fc
      .oneof(fc.constantFrom(RESUME - 1, RESUME, RESUME + 1, LIMIT - 1, LIMIT), fc.integer({ min: 1, max: LIMIT }))
      .map((seq) => ({ kind: 'у границ' as const, seq })),
  },
  {
    weight: 2,
    arbitrary: fc
      .oneof(fc.integer({ min: 0, max: 12 }).map((x) => x + 0.5), fc.constantFrom(1.0000000000000004, 6.000000000000001, 0.5))
      .map((seq) => ({ kind: 'дробное' as const, seq })),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(LIMIT + 1, 2 ** 53, 1e300, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, -0).map((seq) => ({ kind: 'за границей' as const, seq })),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 3 }).map((seq) => ({ kind: 'строка' as const, seq })) },
  { weight: 1, arbitrary: fc.date({ noInvalidDate: true }).map((seq) => ({ kind: 'дата' as const, seq })) },
  { weight: 1, arbitrary: fc.uint8Array({ maxLength: 3 }).map((seq) => ({ kind: 'двоичные' as const, seq })) },
  {
    weight: 1,
    arbitrary: fc.array(fc.oneof(fc.integer({ min: -2, max: 12 }), fc.string({ maxLength: 2 })), { maxLength: 2 }).map((seq) => ({ kind: 'массив' as const, seq })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom<unknown>(Number.NaN, null, undefined, true, false, {}, [Number.NaN], new Date(Number.NaN))
      .map((seq) => ({ kind: 'не ключ' as const, seq })),
  },
);

/** Ключ записи раунда: обычно свой id, иногда — не строка (в испорченном хранилище и такое лежит). */
const ROUND_ID = fc.oneof(
  { weight: 8, arbitrary: fc.constant<unknown>(null) },
  { weight: 1, arbitrary: fc.oneof(fc.integer({ min: 0, max: 9 }), fc.constant([1, 'x']), fc.constant(new Date(7))) },
);

const PLANTED = fc.record({
  seq: SEQ,
  id: ROUND_ID,
  fixture: fc.constantFrom(...FIXTURES),
  bet: fc.constantFrom(20, 100, 1000),
  status: fc.constantFrom('active', 'closed'),
  afterBet: fc.oneof(fc.integer({ min: 0, max: 200_000 }), fc.constantFrom(LIMIT - 35, LIMIT - 1000, LIMIT - 50_000_000)),
  withKey: fc.boolean(),
});

type Planted = typeof PLANTED extends fc.Arbitrary<infer T> ? T : never;

/** Счётчик: обычный, у границ продолжения и записей, любой в границах. */
const COUNT = (min: number): fc.Arbitrary<number> =>
  fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min, max: min + 12 }) },
    { weight: 1, arbitrary: fc.constantFrom(RESUME, RESUME + 1, LIMIT - 2, LIMIT - 1, LIMIT) },
    { weight: 1, arbitrary: fc.integer({ min, max: LIMIT }) },
  );
const BALANCE = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 200_000 }) },
  { weight: 1, arbitrary: fc.constantFrom(0, 19, LIMIT - 50_000_000, LIMIT - 50_000_000 + 1, LIMIT) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: LIMIT }) },
);

type WalletPlan =
  | { readonly kind: 'нет' }
  | {
      readonly kind: 'поодиночке' | 'согласованный' | 'испорченный';
      readonly balance: number;
      readonly active: number | null;
      readonly next: number;
      readonly revision: number;
      readonly back: number;
      readonly garbage: unknown;
    };

const WALLET: fc.Arbitrary<WalletPlan> = fc.oneof(
  fc.constant<WalletPlan>({ kind: 'нет' }),
  fc
    .record({
      kind: fc.constantFrom('поодиночке' as const, 'согласованный' as const, 'согласованный' as const, 'испорченный' as const),
      balance: BALANCE,
      active: fc.option(fc.nat(5), { nil: null }),
      next: COUNT(1),
      revision: COUNT(0),
      back: fc.nat(20),
      garbage: fc.constantFrom<unknown>('x', 7.5, 2 ** 53, -1, null, undefined),
    })
    .map((plan): WalletPlan => plan),
);

const STATE = fc.record({
  rounds: fc.uniqueArray(PLANTED, {
    maxLength: 5,
    // Уникальный индекс seq не пустит два одинаковых ключа — такого состояния нет и в IndexedDB. Не-ключи не сталкиваются.
    selector: (round) => {
      const key = toKey(round.seq.seq);
      return key === null ? round : keyId(key);
    },
  }),
  wallet: WALLET,
});

interface RoundLike {
  readonly roundId: unknown;
  readonly seq: unknown;
  readonly betMinor: number;
  readonly seed: number;
  readonly status: string;
}

function roundRecord(round: Planted, index: number): Record<string, unknown> {
  const fixture = fixtureRound(round.fixture);
  const win = ownWin(round.bet, fixture.payX100);
  const afterBet = Math.min(round.afterBet, LIMIT - win);
  return {
    roundId: round.id ?? `p${String(index)}`,
    seq: round.seq.seq,
    idempotencyKey: `pk${String(index)}`,
    betMinor: round.bet,
    seed: fixture.seed,
    payX100: fixture.payX100,
    winMinor: win,
    events: fixture.events,
    createdAt: T0,
    status: round.status,
    balanceAfterBet: afterBet,
    balanceAfterEnd: round.status === 'closed' ? afterBet + win : null,
  };
}

function walletRecord(plan: WalletPlan, rounds: readonly Record<string, unknown>[]): Record<string, unknown> | null {
  if (plan.kind === 'нет') return null;
  const pointed = plan.active === null ? null : (rounds[plan.active] ?? null);
  const activeRoundId = pointed === null ? null : typeof pointed['roundId'] === 'string' ? pointed['roundId'] : 'px';
  if (plan.kind === 'согласованный') {
    // Согласован по своей проверке: nextSeq впереди всех seq в границах, активный — раунд со своим балансом.
    const highest = Math.max(0, ...rounds.map((round) => round['seq']).filter(isRecordSeq));
    const next = Math.min(LIMIT, highest + 1 + (plan.next % 5));
    const active = pointed !== null && pointed['status'] === 'active' && typeof pointed['roundId'] === 'string' ? pointed : null;
    return {
      id: 'main',
      balanceMinor: active === null ? plan.balance : active['balanceAfterBet'],
      activeRoundId: active === null ? null : active['roundId'],
      nextSeq: next,
      revision: plan.revision,
      resetSeq: Math.max(1, next - plan.back),
    };
  }
  const wallet: Record<string, unknown> = {
    id: 'main',
    balanceMinor: plan.balance,
    activeRoundId,
    nextSeq: plan.next,
    revision: plan.revision,
    resetSeq: Math.max(1, plan.next - plan.back),
  };
  if (plan.kind === 'испорченный') wallet[['balanceMinor', 'nextSeq', 'revision', 'resetSeq', 'activeRoundId'][plan.back % 5] ?? 'revision'] = plan.garbage;
  return wallet;
}

interface Outcome {
  readonly repairs: number;
  readonly failures: readonly string[];
}

async function runClient(rig: Rig, storage: MemoryStorage, planted: readonly Record<string, unknown>[]): Promise<Outcome> {
  const failures: string[] = [];
  let repairs = 0;
  let resetPoint = false;
  let balance = 0;
  let activeWin = 0;
  const send = async <T>(body: RequestBody): Promise<T | null> => {
    const response: ResponseEnvelope = await rig.server.handle({ v: 1, id: 1, body });
    const parsed = parseResponse(body.type, response);
    const stored = storage.snapshot().wallet[0]?.[1];
    if (stored !== undefined && checkWallet(stored) !== null) failures.push(`${body.type}: кошелёк испорчен записью — ${String(checkWallet(stored))}`);
    if (parsed.kind !== 'result') {
      failures.push(`${body.type}: ${parsed.kind === 'error' ? `${parsed.error.code} ${JSON.stringify(parsed.error)}` : parsed.kind}`);
      return null;
    }
    const wallet = (parsed.result as { wallet: { balanceMinor: number; notice: string | null } }).wallet;
    if (wallet.notice === 'reset') {
      repairs += 1;
      resetPoint = true;
    }
    balance = wallet.balanceMinor;
    return parsed.result as T;
  };

  const auth = await send<{ balanceMinor: number; activeRound: { roundId: string } | null; wallet: { notice: string | null } }>({ type: 'authenticate' });
  if (auth === null) return { repairs, failures };
  const base = auth.balanceMinor;
  if (auth.activeRound !== null) {
    const { roundId } = auth.activeRound;
    const record = planted.find((round) => round['roundId'] === roundId);
    const ended = await send<{ balanceMinor: number }>({ type: 'endRound', roundId });
    if (ended !== null && record !== undefined) activeWin = ownWin(record['betMinor'] as number, RECORDED.get(record['seed'] as number)?.payX100 ?? 0);
  }
  for (let spin = 1; spin <= SPINS; spin++) {
    if (balance < BET) {
      if ((await send({ type: 'resetBalance' })) === null) return { repairs, failures };
      resetPoint = true;
    }
    const played = await send<{ round: { roundId: string } }>({ type: 'play', betMinor: BET, idempotencyKey: `q${String(spin)}` });
    if (played === null) return { repairs, failures };
    if ((await send({ type: 'endRound', roundId: played.round.roundId })) === null) return { repairs, failures };
  }

  // Деньги: от последнего сброса — по раундам с seq ≥ resetSeq; сброса не было — от баланса на входе.
  const snapshot = storage.snapshot();
  const wallet = snapshot.wallet[0]?.[1] as { balanceMinor: number; resetSeq: number } | undefined;
  const rounds = snapshot.rounds.map(([, value]) => value as RoundLike);
  const ours = (round: RoundLike): boolean => typeof round.roundId === 'string' && /^r\d+$/.test(round.roundId);
  const counted = resetPoint ? rounds.filter((round) => isRecordSeq(round.seq) && round.seq >= (wallet?.resetSeq ?? 0)) : rounds.filter(ours);
  if (counted.some((round) => !ours(round))) failures.push(`после сброса в сверке чужой раунд: ${JSON.stringify(counted.filter((round) => !ours(round)).map((round) => round.roundId))}`);
  const moved = counted.reduce(
    (sum, round) => sum - round.betMinor + (round.status === 'closed' ? ownWin(round.betMinor, RECORDED.get(round.seed)?.payX100 ?? 0) : 0),
    0,
  );
  const expected = (resetPoint ? START : base + activeWin) + moved;
  if (wallet?.balanceMinor !== expected) failures.push(`баланс ${String(wallet?.balanceMinor)}, по раундам ${String(expected)}`);
  return { repairs, failures };
}

describe('инвариант хранилища: вечного INTERNAL нет', () => {
  it('после не больше одной починки 10 спинов проходят, деньги сходятся от последнего сброса', async () => {
    const kinds = new Map<string, number>();
    const branches = { repaired: 0, healthy: 0 };
    await fc.assert(
      fc.asyncProperty(STATE, async (state) => {
        const planted = state.rounds.map(roundRecord);
        const walletValue = walletRecord(state.wallet, planted);
        const ops: WriteOp[] = planted.map((value) => ({ op: 'put', store: 'rounds', value }));
        state.rounds.forEach((round, index) => {
          const record = planted[index];
          if (round.withKey && record !== undefined) ops.push({ op: 'put', store: 'keys', value: { key: record['idempotencyKey'], roundId: record['roundId'], betMinor: round.bet } });
        });
        if (walletValue !== null) ops.push({ op: 'put', store: 'wallet', value: walletValue });
        const storage = new MemoryStorage({ durable: true });
        await plant(storage, ops);
        const rig = new Rig({ storage, seeds: SEEDS });
        const outcome = await runClient(rig, storage, planted);
        expect(outcome.failures).toStrictEqual([]);
        expect(outcome.repairs).toBeLessThanOrEqual(1);
        expect(rig.broadcast.messages.filter((message) => message.notice === 'reset').length).toBe(outcome.repairs);
        for (const round of state.rounds) kinds.set(round.seq.kind, (kinds.get(round.seq.kind) ?? 0) + 1);
        kinds.set(`кошелёк ${state.wallet.kind}`, (kinds.get(`кошелёк ${state.wallet.kind}`) ?? 0) + 1);
        if (outcome.repairs > 0) branches.repaired += 1;
        else branches.healthy += 1;
      }),
      { numRuns: 1000, timeout: RUN_TIMEOUT_MS },
    );
    // Охват: каждый вид ключа seq и каждый вид кошелька встретился; обе ветви — с починкой и без.
    const expectedKinds = ['целое', 'у границ', 'дробное', 'за границей', 'строка', 'дата', 'двоичные', 'массив', 'не ключ'];
    const walletKinds = ['нет', 'поодиночке', 'согласованный', 'испорченный'].map((kind) => `кошелёк ${kind}`);
    expect([...expectedKinds, ...walletKinds].filter((kind) => (kinds.get(kind) ?? 0) === 0)).toStrictEqual([]);
    expect(branches.repaired).toBeGreaterThan(0);
    expect(branches.healthy).toBeGreaterThan(0);
  }, 120_000);
});
