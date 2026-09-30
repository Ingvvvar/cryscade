import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseResponse, type RequestBody } from '../../src/protocol/index.ts';
import { checkWallet } from '../../src/server/records.ts';
import { MemoryStorage, type WriteOp } from '../../src/server/index.ts';
import { fixtureRound } from '../support/fixture-rounds.ts';
import { RUN_TIMEOUT_MS } from '../support/property-run.ts';
import { Rig, T0, plant } from '../support/rgs-rig.ts';

// Хранилище переживает испорченное состояние: записи кошелька, раундов и ключей с поломками в случайных полях
// (или без записи вовсе). На любом таком состоянии сервер не бросает, не отвечает INTERNAL, каждый его ответ
// проходит гард клиента, а кошелёк в хранилище после каждого запроса цел или ещё не записан.

const SMALL = fixtureRound('small-win');
const BASE = fixtureRound('base-win');

type Fields = Record<string, unknown>;

const WALLET: Fields = { id: 'main', balanceMinor: 99_900, activeRoundId: 'r7', nextSeq: 8, revision: 12, resetSeq: 1 };
const ACTIVE: Fields = {
  roundId: 'r7',
  seq: 7,
  idempotencyKey: 'k7',
  betMinor: 100,
  seed: 0,
  payX100: 95,
  winMinor: 95,
  events: SMALL.events,
  createdAt: T0,
  status: 'active',
  balanceAfterBet: 99_900,
  balanceAfterEnd: null,
};
const CLOSED: Fields = {
  roundId: 'r6',
  seq: 6,
  idempotencyKey: 'k6',
  betMinor: 100,
  seed: 2,
  payX100: 105,
  winMinor: 105,
  events: BASE.events,
  createdAt: T0,
  status: 'closed',
  balanceAfterBet: 99_895,
  balanceAfterEnd: 100_000,
};

const VALUE = fc.oneof(
  fc.anything({ withNullPrototype: true, withSparseArray: true, maxDepth: 2 }),
  fc.integer({ min: -2, max: 12 }),
  fc.constantFrom('r6', 'r7', 'k6', 'k7', 'active', 'closed', null, Number.MAX_SAFE_INTEGER, 0.5),
);

/** Поломка поля записи; ключевое поле хранилища остаётся, иначе запись просто не лежала бы на месте. */
const FIELD_DAMAGE = fc.array(fc.record({ field: fc.nat(), value: VALUE, drop: fc.boolean() }), { maxLength: 3 });

function damaged(record: Fields, keyField: string, damage: readonly { field: number; value: unknown; drop: boolean }[]): Fields {
  const copy = structuredClone(record);
  const fields = Object.keys(copy).filter((name) => name !== keyField);
  for (const { field, value, drop } of damage) {
    const name = fields[field % fields.length] ?? keyField;
    if (drop) Reflect.deleteProperty(copy, name);
    else copy[name] = value;
  }
  return copy;
}

const STATE = fc.record({
  wallet: fc.option(FIELD_DAMAGE, { nil: null }),
  active: fc.option(FIELD_DAMAGE, { nil: null }),
  closed: fc.option(FIELD_DAMAGE, { nil: null }),
  k6: fc.option(FIELD_DAMAGE, { nil: null }),
  k7: fc.option(FIELD_DAMAGE, { nil: null }),
});

const REQUEST: fc.Arbitrary<RequestBody> = fc.oneof(
  fc.constant<RequestBody>({ type: 'authenticate' }),
  fc.constant<RequestBody>({ type: 'resetBalance' }),
  fc.constantFrom('r6', 'r7', 'r1', 'r9').map((roundId): RequestBody => ({ type: 'endRound', roundId })),
  fc
    .tuple(fc.constantFrom(20, 100, 200), fc.constantFrom('k6', 'k7', 'k8', 'k9'))
    .map(([betMinor, idempotencyKey]): RequestBody => ({ type: 'play', betMinor, idempotencyKey })),
);

describe('испорченное хранилище не роняет сервер', () => {
  it('ответы проходят гард клиента, INTERNAL нет, кошелёк после запроса цел', async () => {
    let repaired = 0;
    let healthy = 0;
    await fc.assert(
      fc.asyncProperty(STATE, fc.array(REQUEST, { minLength: 1, maxLength: 5 }), async (state, requests) => {
        const storage = new MemoryStorage({ durable: true });
        const ops: WriteOp[] = [];
        if (state.wallet !== null) ops.push({ op: 'put', store: 'wallet', value: damaged(WALLET, 'id', state.wallet) });
        if (state.active !== null) ops.push({ op: 'put', store: 'rounds', value: damaged(ACTIVE, 'roundId', state.active) });
        if (state.closed !== null) ops.push({ op: 'put', store: 'rounds', value: damaged(CLOSED, 'roundId', state.closed) });
        if (state.k6 !== null) ops.push({ op: 'put', store: 'keys', value: damaged({ key: 'k6', roundId: 'r6', betMinor: 100 }, 'key', state.k6) });
        if (state.k7 !== null) ops.push({ op: 'put', store: 'keys', value: damaged({ key: 'k7', roundId: 'r7', betMinor: 100 }, 'key', state.k7) });
        // Уникальный seq может не пустить две испорченные записи на одно место — такого состояния и в IndexedDB нет.
        try {
          await plant(storage, ops);
        } catch {
          return;
        }
        const rig = new Rig({ storage, seeds: [1, 0, 2, 1, 1] });
        for (const body of requests) {
          const response = await rig.server.handle({ v: 1, id: 1, body });
          const parsed = parseResponse(body.type, response);
          expect(parsed.kind === 'result' || parsed.kind === 'error').toBe(true);
          expect(parsed.kind === 'error' ? parsed.error.code : 'ok').not.toBe('INTERNAL');
          // Кошелька может не быть, только пока сервер ничего не писал: новый кошелёк пишется первой записью.
          const stored = storage.snapshot().wallet[0]?.[1];
          if (stored !== undefined) expect(checkWallet(stored)).toBeNull();
        }
        if (storage.snapshot().quarantine.length > 0 || rig.broadcast.messages.some((message) => message.notice === 'reset')) repaired += 1;
        else healthy += 1;
      }),
      { numRuns: 1000, timeout: RUN_TIMEOUT_MS },
    );
    // Обе ветви пройдены: состояния, которые чинятся, и состояния, которые служат как есть.
    expect(repaired).toBeGreaterThan(0);
    expect(healthy).toBeGreaterThan(0);
  }, 60_000);
});
