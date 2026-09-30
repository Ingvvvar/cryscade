import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RoundEvent } from '../../src/core/model/events.ts';
import { checkWalletChanged, parseRequest, parseResponse } from '../../src/protocol/index.ts';
import { checkFairness, checkKey, checkRound, checkSecret, checkWallet } from '../../src/server/records.ts';
import { fixtureRound } from '../support/fixture-rounds.ts';

// Класс «целое по смыслу поле» (после 2^53 и дробного seq): в записях хранилища и сообщениях протокола каждое число —
// целое по смыслу, поэтому гард обязан отвергнуть дробное и 2^53 в любом числовом листе любого образца. Образцы —
// годные записи и сообщения всех видов; события — из фикстур biggest (кап) и retrigger (ретриггер), вместе в них все
// одиннадцать типов событий. Каждый образец сам по себе годен — отказ идёт от подменённого листа.

type Path = readonly (string | number)[];

interface Sample {
  readonly name: string;
  readonly value: unknown;
  readonly accepts: (value: unknown) => boolean;
}

const BIGGEST = fixtureRound('biggest');
const RETRIGGER = fixtureRound('retrigger');
const SMALL = fixtureRound('small-win');
const EVENT_TYPES = ['fill', 'win', 'explode', 'spots', 'refill', 'scatters', 'fsStart', 'fsSpin', 'fsRetrigger', 'cap', 'end'] as const;

const WALLET = { id: 'main', balanceMinor: 99_900, activeRoundId: 'r7', nextSeq: 8, revision: 12, resetSeq: 3 };
/** Активный раунд biggest: ставка 100, итог 5000× — выигрыш 500 000, литералом. */
const ACTIVE = {
  roundId: 'r7',
  seq: 7,
  idempotencyKey: 'k7',
  betMinor: 100,
  seed: 801_200,
  payX100: 500_000,
  winMinor: 500_000,
  events: BIGGEST.events,
  createdAt: 1_790_000_000_000,
  status: 'active',
  balanceAfterBet: 99_900,
  balanceAfterEnd: null,
};
/** Закрытый раунд small-win: ставка 100, итог 0.95× — выигрыш 95. */
const CLOSED = { ...ACTIVE, roundId: 'r6', seq: 6, seed: 0, payX100: 95, winMinor: 95, events: SMALL.events, status: 'closed', balanceAfterEnd: 99_995 };
/** Закрытый раунд retrigger: ставка 100, итог 18.40× — выигрыш 1840. */
const RETRIGGERED = { ...CLOSED, roundId: 'r5', seq: 5, seed: 3407, payX100: 1840, winMinor: 1840, events: RETRIGGER.events, balanceAfterEnd: 101_740 };
const KEY = { key: 'k7', roundId: 'r7', betMinor: 100 };
const HEX = 'ab'.repeat(32);
/** Раунд книги (фаза 6): индекс записи, nonce, обязательство и сид игрока. */
const BOOK_ROUND = { ...CLOSED, roundId: 'r4', seq: 4, source: 'book', bookIndex: 1234, nonce: 5, commitment: HEX, clientSeed: 'Seed01' };
const FAIRNESS = { id: 'main', commitment: HEX, clientSeed: 'Seed01', nonce: 6 };
const SECRET = { commitment: HEX, secret: 'cd'.repeat(32), createdAt: 1_790_000_000_000, revealedAt: 1_790_000_100_000 };
const FAIRNESS_VIEW = { commitment: HEX, clientSeed: 'Seed01', nonce: 6 };

const view = (events: readonly RoundEvent[], payX100: number, winMinor: number) => ({
  roundId: 'r7',
  betMinor: 100,
  payX100,
  winMinor,
  events,
  source: 'book',
  bookIndex: 1234,
  nonce: 5,
});
const WALLET_VIEW = { balanceMinor: 99_900, revision: 12, notice: null };
const response = (body: unknown) => ({ v: 1, id: 3, body });
const result = (value: unknown) => response({ ok: true, result: value });
const failure = (error: unknown) => response({ ok: false, error });

const SAMPLES: readonly Sample[] = [
  { name: 'запись кошелька', value: WALLET, accepts: (value) => checkWallet(value) === null },
  { name: 'запись активного раунда', value: ACTIVE, accepts: (value) => checkRound(value) === null },
  { name: 'запись закрытого раунда', value: CLOSED, accepts: (value) => checkRound(value) === null },
  { name: 'запись закрытого раунда с ретриггером', value: RETRIGGERED, accepts: (value) => checkRound(value) === null },
  { name: 'запись ключа', value: KEY, accepts: (value) => checkKey(value) === null },
  { name: 'запись раунда книги', value: BOOK_ROUND, accepts: (value) => checkRound(value) === null },
  { name: 'запись честности', value: FAIRNESS, accepts: (value) => checkFairness(value) === null },
  { name: 'запись секрета', value: SECRET, accepts: (value) => checkSecret(value) === null },
  { name: 'запрос play', value: { v: 1, id: 7, body: { type: 'play', betMinor: 100, idempotencyKey: 'k7' } }, accepts: (value) => parseRequest(value).ok },
  { name: 'запрос history', value: { v: 1, id: 8, body: { type: 'history', limit: 20 } }, accepts: (value) => parseRequest(value).ok },
  { name: 'запрос replay книги', value: { v: 1, id: 9, body: { type: 'replay', book: 58_353 } }, accepts: (value) => parseRequest(value).ok },
  {
    name: 'ответ rotateSeed',
    value: result({ fairness: FAIRNESS_VIEW, revealed: { commitment: HEX, secret: 'cd'.repeat(32) } }),
    accepts: (value) => parseResponse('rotateSeed', value).kind === 'result',
  },
  {
    name: 'ответ history',
    value: result({
      rounds: [
        {
          roundId: 'r4',
          createdAt: 1_790_000_000_000,
          betMinor: 100,
          payX100: 95,
          winMinor: 95,
          status: 'closed',
          source: 'book',
          bookIndex: 1234,
          nonce: 5,
          commitment: HEX,
          clientSeed: 'Seed01',
          secret: null,
        },
      ],
    }),
    accepts: (value) => parseResponse('history', value).kind === 'result',
  },
  {
    name: 'ответ replay книги',
    value: result({ roundId: null, bookIndex: 58_353, betMinor: 100, payX100: 95, winMinor: 95, events: SMALL.events }),
    accepts: (value) => parseResponse('replay', value).kind === 'result',
  },
  { name: 'ответ loadBook', value: result({ records: 58_354 }), accepts: (value) => parseResponse('loadBook', value).kind === 'result' },
  {
    name: 'ответ authenticate',
    value: result({
      balanceMinor: 99_900,
      config: { betLevelsMinor: [20, 40, 100, 200, 400, 1000, 2000, 5000, 10_000], capX100: 500_000 },
      activeRound: view(BIGGEST.events, 500_000, 500_000),
      idleGrid: BIGGEST.events[0]?.t === 'fill' ? BIGGEST.events[0].grid : [],
      notice: null,
      wallet: WALLET_VIEW,
      fairness: FAIRNESS_VIEW,
    }),
    accepts: (value) => parseResponse('authenticate', value).kind === 'result',
  },
  {
    name: 'ответ play',
    value: result({ round: view(SMALL.events, 95, 95), balanceMinor: 99_900, wallet: WALLET_VIEW }),
    accepts: (value) => parseResponse('play', value).kind === 'result',
  },
  { name: 'ответ endRound', value: result({ balanceMinor: 99_995, wallet: WALLET_VIEW }), accepts: (value) => parseResponse('endRound', value).kind === 'result' },
  {
    name: 'ответ resetBalance',
    value: result({ balanceMinor: 100_000, wallet: WALLET_VIEW }),
    accepts: (value) => parseResponse('resetBalance', value).kind === 'result',
  },
  {
    name: 'ошибка INSUFFICIENT_FUNDS',
    value: failure({ code: 'INSUFFICIENT_FUNDS', balanceMinor: 10 }),
    accepts: (value) => parseResponse('play', value).kind === 'error',
  },
  { name: 'ошибка INVALID_BET', value: failure({ code: 'INVALID_BET', betMinor: 30 }), accepts: (value) => parseResponse('play', value).kind === 'error' },
  {
    name: 'ошибка VERSION_MISMATCH',
    value: failure({ code: 'VERSION_MISMATCH', supported: 1 }),
    accepts: (value) => parseResponse('play', value).kind === 'error',
  },
  {
    name: 'оповещение walletChanged',
    value: { v: 1, type: 'walletChanged', balanceMinor: 99_900, activeRoundId: 'r7', revision: 12, notice: null },
    accepts: (value) => checkWalletChanged(value) === null,
  },
];

/** Пути ко всем числовым листьям значения. */
function numericLeaves(value: unknown, path: Path = []): Path[] {
  if (typeof value === 'number') return [path];
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.flatMap((item, index) => numericLeaves(item, [...path, index]));
  }
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([name, item]) => numericLeaves(item, [...path, name]));
  return [];
}

/** Копия образца с другим числом в листе. */
function withLeaf(sample: unknown, path: Path, leaf: number): unknown {
  const copy: unknown = structuredClone(sample);
  let parent = copy as Record<string | number, unknown>;
  for (const step of path.slice(0, -1)) parent = parent[step] as Record<string | number, unknown>;
  parent[path.at(-1) ?? ''] = leaf;
  return copy;
}

function leafAt(sample: unknown, path: Path): number {
  let at: unknown = sample;
  for (const step of path) at = (at as Record<string | number, unknown>)[step];
  return at as number;
}

const LEAVES = SAMPLES.flatMap((sample) => numericLeaves(sample.value).map((path) => ({ sample, path })));

describe('целые поля хранилища и протокола', () => {
  it('охват: каждый образец годен и с числами, листьев больше тысячи, в событиях все одиннадцать типов', () => {
    expect(SAMPLES.map((sample) => [sample.name, sample.accepts(sample.value)])).toStrictEqual(SAMPLES.map((sample) => [sample.name, true]));
    expect(SAMPLES.filter((sample) => numericLeaves(sample.value).length === 0).map((sample) => sample.name)).toStrictEqual([]);
    expect(LEAVES.length).toBeGreaterThan(1000);
    const events = [...BIGGEST.events, ...RETRIGGER.events];
    expect(EVENT_TYPES.filter((type) => !events.some((event) => event.t === type))).toStrictEqual([]);
  });

  it('каждый лист: своё значение + 0.5 и 2^53 — отказ', () => {
    const passed = LEAVES.flatMap(({ sample, path }) =>
      [leafAt(sample.value, path) + 0.5, 2 ** 53]
        .filter((leaf) => sample.accepts(withLeaf(sample.value, path, leaf)))
        .map((leaf) => `${sample.name} ${path.join('.')} = ${String(leaf)}`),
    );
    expect(passed).toStrictEqual([]);
  });

  it('property: любой лист, x + 0.5 при любом целом x до 2^52 — отказ', () => {
    fc.assert(
      fc.property(fc.nat(LEAVES.length - 1), fc.oneof(fc.nat(100), fc.integer({ min: 0, max: 2 ** 52 - 1 })), (index, x) => {
        const leaf = LEAVES[index];
        if (leaf === undefined) return false;
        return !leaf.sample.accepts(withLeaf(leaf.sample.value, leaf.path, x + 0.5));
      }),
      { numRuns: 3000 },
    );
  });
});
