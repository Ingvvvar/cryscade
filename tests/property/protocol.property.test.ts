import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EventRecorder } from '../../src/core/engine/index.ts';
import { DEFAULT_CONFIG, type GameConfig } from '../../src/core/model/config.ts';
import type { RoundEvent } from '../../src/core/model/events.ts';
import { finalGrid } from '../../src/core/presentation/final-grid.ts';
import {
  checkError,
  checkRequestBody,
  checkResult,
  checkRoundEvents,
  checkRoundView,
  checkWalletChanged,
  parseRequest,
  parseResponse,
  type RequestType,
} from '../../src/protocol/index.ts';
import { MemoryLock, MemoryStorage, RgsServer } from '../../src/server/index.ts';
import { checkKey, checkRound, checkRoundCore, checkWallet } from '../../src/server/records.ts';
import { STRESS_CONFIG } from '../support/configs.ts';
import { FIXTURE_NAMES, fixtureRound } from '../support/fixture-rounds.ts';
import { RUN_TIMEOUT_MS } from '../support/property-run.ts';
import { FixedClock, ScriptedEntropy, T0 } from '../support/rgs-rig.ts';
import { guarded } from '../support/watchdog.ts';
import { NodeCrypto } from '../support/node-crypto.ts';

// Гарды на границе (§6.1): на произвольном мусоре не бросают и отвечают «нет»; на записанных раундах с поломками
// в случайном месте не бросают, а всё, что пропустили, презентация собирает в полную сетку, не падая.
// Настоящие раунды движка гард пропускает все — иначе сервер отвергал бы свои же раунды.

const GARBAGE = fc.anything({
  withBigInt: true,
  withBoxedValues: true,
  withDate: true,
  withMap: true,
  withSet: true,
  withNullPrototype: true,
  withObjectString: true,
  withSparseArray: true,
  withTypedArray: true,
  withUnicodeString: true,
});

const TYPES: readonly RequestType[] = ['authenticate', 'play', 'endRound', 'resetBalance'];

/** Гарды, которые отвечают строкой проблемы или null. */
const CHECKS: readonly [string, (value: unknown) => string | null][] = [
  ['checkRoundEvents', checkRoundEvents],
  ['checkRoundView', checkRoundView],
  ['checkRequestBody', checkRequestBody],
  ['checkError', checkError],
  ['checkWalletChanged', checkWalletChanged],
  ...TYPES.map((type): [string, (value: unknown) => string | null] => [`checkResult ${type}`, (value) => checkResult(type, value)]),
  ['checkWallet', checkWallet],
  ['checkRoundCore', checkRoundCore],
  ['checkRound', checkRound],
  ['checkKey', checkKey],
];

describe('мусор не роняет гарды', () => {
  it.each(CHECKS)('%s: не бросает и отвечает «нет»', (_name, check) => {
    fc.assert(
      fc.property(GARBAGE, (value) => {
        expect(check(value)).toEqual(expect.any(String));
      }),
      { numRuns: 1000 },
    );
  });

  it('parseRequest и parseResponse: не бросают, мусор — не запрос и не ответ', () => {
    fc.assert(
      fc.property(GARBAGE, fc.constantFrom(...TYPES), (value, type) => {
        expect(parseRequest(value).ok).toBe(false);
        expect(parseResponse(type, value).kind).not.toBe('result');
      }),
      { numRuns: 2000 },
    );
  });

  it('конверт с мусором внутри — тоже', () => {
    fc.assert(
      fc.property(fc.nat(), GARBAGE, fc.constantFrom(...TYPES), (id, body, type) => {
        expect(parseRequest({ v: 1, id, body }).ok).toBe(false);
        expect(parseResponse(type, { v: 1, id, body: { ok: true, result: body } }).kind).toBe('invalid');
      }),
      { numRuns: 2000 },
    );
  });
});

type Path = readonly (string | number)[];

const isPlainObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);

/** Пути ко всем узлам. Вглубь — только простые массивы и объекты: типизированный массив, Map, Date — лист. */
function pathsOf(value: unknown, prefix: Path = []): Path[] {
  const own = prefix.length === 0 ? [] : [prefix];
  if (Array.isArray(value)) return [...own, ...value.flatMap((item, index) => pathsOf(item, [...prefix, index]))];
  if (isPlainObject(value)) return [...own, ...Object.entries(value).flatMap(([key, item]) => pathsOf(item, [...prefix, key]))];
  return own;
}

function parentOf(root: unknown, path: Path): Record<string | number, unknown> {
  let node = root;
  for (const step of path.slice(0, -1)) node = (node as Record<string | number, unknown>)[step];
  return node as Record<string | number, unknown>;
}

type Mutation =
  | { readonly kind: 'replace'; readonly at: number; readonly value: unknown }
  | { readonly kind: 'nudge'; readonly at: number; readonly delta: number }
  | { readonly kind: 'drop'; readonly at: number }
  | { readonly kind: 'swap'; readonly at: number };

const MUTATION: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ kind: fc.constant('replace' as const), at: fc.nat(), value: GARBAGE }),
  // Сдвиг числа на ±1…3 чаще остаётся в границах строения и доходит до грамматики и сверки сетки.
  fc.record({ kind: fc.constant('nudge' as const), at: fc.nat(), delta: fc.integer({ min: -3, max: 3 }).filter((d) => d !== 0) }),
  fc.record({ kind: fc.constant('drop' as const), at: fc.nat() }),
  fc.record({ kind: fc.constant('swap' as const), at: fc.nat() }),
);

function mutate(events: unknown[], mutation: Mutation): void {
  const paths = pathsOf(events);
  const path = paths[mutation.at % paths.length];
  if (path === undefined) return;
  const parent = parentOf(events, path);
  const last = path.at(-1) ?? 0;
  switch (mutation.kind) {
    case 'replace':
      parent[last] = mutation.value;
      return;
    case 'nudge': {
      const value = parent[last];
      if (typeof value === 'number') parent[last] = value + mutation.delta;
      return;
    }
    case 'drop':
      if (Array.isArray(parent) && typeof last === 'number') (parent as unknown[]).splice(last, 1);
      else Reflect.deleteProperty(parent, last);
      return;
    case 'swap': {
      const items = parent as unknown as unknown[];
      if (Array.isArray(items) && typeof last === 'number' && last + 1 < items.length) {
        [items[last], items[last + 1]] = [items[last + 1], items[last]];
      }
      return;
    }
  }
}

describe('сервер на мусоре', () => {
  it('не бросает, отвечает BAD_REQUEST или VERSION_MISMATCH и ничего не пишет', async () => {
    const storage = new MemoryStorage({ durable: true });
    const server = new RgsServer(
      { storage, lock: new MemoryLock(), clock: new FixedClock(T0), entropy: new ScriptedEntropy([]), broadcast: { walletChanged: () => undefined }, crypto: new NodeCrypto() },
      { config: DEFAULT_CONFIG, rounds: { kind: 'live' } },
    );
    await fc.assert(
      fc.asyncProperty(fc.oneof(GARBAGE, fc.record({ v: fc.oneof(fc.constant(1), GARBAGE), id: fc.oneof(fc.nat(), GARBAGE), body: GARBAGE })), async (raw) => {
        const response = await server.handle(raw);
        expect(response.body.ok).toBe(false);
        expect(response.body.ok ? null : response.body.error.code).toMatch(/^(BAD_REQUEST|VERSION_MISMATCH)$/);
      }),
      { numRuns: 1000, timeout: RUN_TIMEOUT_MS },
    );
    expect(storage.snapshot()).toStrictEqual({ wallet: [], rounds: [], keys: [], quarantine: [], fairness: [], secrets: [] });
  });
});

describe('испорченные записанные раунды', () => {
  it('гард не бросает; что пропустил — собирается в полную сетку из символов 0…7', () => {
    let accepted = 0;
    let rejected = 0;
    fc.assert(
      fc.property(fc.constantFrom(...FIXTURE_NAMES), fc.array(MUTATION, { minLength: 1, maxLength: 3 }), (name, mutations) => {
        const events = structuredClone(fixtureRound(name).events) as unknown[];
        for (const mutation of mutations) mutate(events, mutation);
        const problem = checkRoundEvents(events);
        if (problem !== null) {
          rejected += 1;
          return;
        }
        accepted += 1;
        const grid = finalGrid(events as RoundEvent[]);
        expect(grid).toHaveLength(49);
        expect(grid.every((symbol) => Number.isInteger(symbol) && symbol >= 0 && symbol <= 7)).toBe(true);
      }),
      { numRuns: 5000 },
    );
    // Обе ветви пройдены: иначе либо гард пропускает всё, либо поломки не доходят до сверки сетки.
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });
});

describe('настоящие раунды движка гард пропускает', () => {
  it.each([
    ['стресс', STRESS_CONFIG],
    ['игра', DEFAULT_CONFIG],
  ] as [string, GameConfig][])('конфиг «%s»', (_name, config) => {
    const recorder = new EventRecorder();
    const engine = guarded(config, recorder);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const payX100 = engine.play(seed);
        expect(checkRoundEvents(recorder.events)).toBeNull();
        expect(checkRoundView({ roundId: 'r1', betMinor: 20, payX100, winMinor: 0, events: recorder.events, source: 'live', bookIndex: null, nonce: null })).toBeNull();
      }),
      { numRuns: 1000 },
    );
  });
});
