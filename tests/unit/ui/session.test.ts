import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from '../../../src/client/index.ts';
import { MoneyFormat } from '../../../src/ui/money-format.ts';
import { SESSION_KEY, SessionTracker } from '../../../src/ui/session.ts';
import { elapsed, signedMoney } from '../../../src/ui/session-strip.tsx';

// Сессия вкладки (§11, решение 6): начало и Σ (выигрыш − ставка) закрытых раундов в sessionStorage; раунд — один раз;
// хранилище пустое, испорченное и недоступное — новая сессия.

class MemoryStore implements KeyValueStore {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

const T0 = 1_790_000_000_000;

describe('SessionTracker', () => {
  it('новая сессия: начало — сейчас, результат 0, запись сразу в хранилище', () => {
    const store = new MemoryStore();
    const session = new SessionTracker(() => store, () => T0);
    expect(session.getSnapshot()).toStrictEqual({ startedAt: T0, netMinor: 0 });
    expect(store.items.get(SESSION_KEY)).toBe(`{"v":1,"startedAt":${String(T0)},"netMinor":0,"last":null}`);
  });

  it('раунды: выигрыш минус ставка; тот же раунд второй раз не считается; подписчики слышат', () => {
    const store = new MemoryStore();
    const session = new SessionTracker(() => store, () => T0);
    let heard = 0;
    session.subscribe(() => {
      heard += 1;
    });
    session.settle({ roundId: 'r1', betMinor: 100, winMinor: 95 });
    session.settle({ roundId: 'r1', betMinor: 100, winMinor: 95 });
    session.settle({ roundId: 'r2', betMinor: 200, winMinor: 0 });
    session.settle({ roundId: 'r3', betMinor: 100, winMinor: 1500 });
    expect(session.getSnapshot()).toStrictEqual({ startedAt: T0, netMinor: 1195 });
    expect(heard).toBe(3);
  });

  it('перезагрузка: сессия из хранилища — начало, результат и последний раунд', () => {
    const store = new MemoryStore();
    const first = new SessionTracker(() => store, () => T0);
    first.settle({ roundId: 'r1', betMinor: 100, winMinor: 0 });
    const reloaded = new SessionTracker(() => store, () => T0 + 60_000);
    expect(reloaded.getSnapshot()).toStrictEqual({ startedAt: T0, netMinor: -100 });
    reloaded.settle({ roundId: 'r1', betMinor: 100, winMinor: 0 });
    expect(reloaded.getSnapshot().netMinor).toBe(-100);
  });

  it.each([
    ['не JSON', '{oops'],
    ['не та версия', '{"v":2,"startedAt":1,"netMinor":0,"last":null}'],
    ['дробное начало', '{"v":1,"startedAt":1.5,"netMinor":0,"last":null}'],
    ['отрицательное начало', '{"v":1,"startedAt":-1,"netMinor":0,"last":null}'],
    ['результат за 2^53', '{"v":1,"startedAt":1,"netMinor":9007199254740992,"last":null}'],
    ['результат строкой', '{"v":1,"startedAt":1,"netMinor":"5","last":null}'],
    ['кривой id', '{"v":1,"startedAt":1,"netMinor":0,"last":"a b"}'],
  ])('испорчена (%s) — новая сессия', (_, raw) => {
    const store = new MemoryStore();
    store.items.set(SESSION_KEY, raw);
    expect(new SessionTracker(() => store, () => T0).getSnapshot()).toStrictEqual({ startedAt: T0, netMinor: 0 });
  });

  it('хранилище недоступно — сессия в памяти', () => {
    const session = new SessionTracker(() => {
      throw new Error('SecurityError');
    }, () => T0);
    session.settle({ roundId: 'r1', betMinor: 100, winMinor: 250 });
    expect(session.getSnapshot()).toStrictEqual({ startedAt: T0, netMinor: 150 });
  });
});

describe('полоса сессии', () => {
  const money = new MoneyFormat('uk-UA');

  it.each([
    [0, '0,00'],
    [1250, '+12,50'],
    [-300, '−3,00'],
    [-123_456, '−1 234,56'],
  ])('результат %d → %s', (minor, text) => {
    expect(signedMoney(money, minor)).toBe(text);
  });

  it.each([
    [0, '00:00'],
    [999, '00:00'],
    [61_000, '01:01'],
    [3_599_000, '59:59'],
    [3_600_000, '1:00:00'],
    [36_061_000, '10:01:01'],
    [-5000, '00:00'],
  ])('время %d мс → %s', (ms, text) => {
    expect(elapsed(ms)).toBe(text);
  });
});
