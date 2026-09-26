import { describe, expect, it } from 'vitest';
import { loadThreshold, verdict, waitForIdle, type Clock } from '../../../tools/math/speed-verdict.ts';

// Решение замера скорости: число пишется, только если нагрузка не выше порога и до, и после замера; до отказа замер
// ждёт, пока нагрузка спадёт. Живой положительный контроль под искусственной нагрузкой —
// `node tools/math/speed.ts --control`.

const SPEED = { silentPerCore: 265_000.4, statsPerCore: 240_000.6 };

describe('порог нагрузки', () => {
  it.each([
    [10, 4],
    [8, 3.2],
    [1, 0.4],
  ])('ядер %i — порог %s', (cores, threshold) => {
    expect(loadThreshold(cores)).toBeCloseTo(threshold, 12);
  });
});

describe('решение замера по нагрузке стенда', () => {
  it('свободный стенд — число пишется вместе с нагрузкой и временем ожидания', () => {
    const result = verdict({ cores: 10, before: 0.8, after: 1.4, threshold: 4, waitedMs: 95_000 }, SPEED, 'Apple M4.');
    expect(result.measured).toBe(true);
    expect(result.text).toContain('тихий режим 265');
    expect(result.text).toContain('ядер 10, порог 4.00 (0.4 × ядра), нагрузка 0.80 до и 1.40 после, ждал 95 с');
  });

  it('ровно на пороге — ещё свободен', () => {
    expect(verdict({ cores: 5, before: 2, after: 2, threshold: 2, waitedMs: 0 }, SPEED, '').measured).toBe(true);
  });

  it.each([
    ['не опустилась за ожидание', { cores: 5, before: 11.74, after: Number.NaN, threshold: 2, waitedMs: 300_000 }, null],
    ['выше порога до замера, даже если число есть', { cores: 5, before: 2.01, after: 1, threshold: 2, waitedMs: 0 }, SPEED],
    ['поднялась за время замера', { cores: 5, before: 1, after: 2.5, threshold: 2, waitedMs: 0 }, SPEED],
    ['нагрузка после неизвестна', { cores: 5, before: 1, after: Number.NaN, threshold: 2, waitedMs: 0 }, SPEED],
    ['замера нет', { cores: 5, before: 1, after: 1, threshold: 2, waitedMs: 0 }, null],
  ])('%s — «стенд занят», числа нет', (_name, load, speed) => {
    const result = verdict(load, speed, 'Apple M4.');
    expect(result.measured).toBe(false);
    expect(result.text).toMatch(/^Стенд занят: ядер 5, порог 2\.00 \(0\.4 × ядра\), нагрузка \d+\.\d\d до/);
    expect(result.text).not.toContain('раундов/с');
  });
});

/** Часы без настоящего ожидания; больше limit снов — ошибка, чтобы сломанное ожидание не висело. */
function fakeClock(limit = 1000): Clock & { readonly sleeps: number } {
  let time = 0;
  let sleeps = 0;
  return {
    now: () => time,
    sleep: (ms) => {
      sleeps += 1;
      if (sleeps > limit) throw new Error('ожидание не кончается');
      time += ms;
      return Promise.resolve();
    },
    get sleeps() {
      return sleeps;
    },
  };
}

describe('ожидание, пока нагрузка спадёт', () => {
  it('хвост своего прогона: 5 → 4 → 1.5 — ждёт 10 с и отпускает на замер', async () => {
    const loads = [5, 4, 1.5];
    const clock = fakeClock();
    const idle = await waitForIdle(() => loads.shift() ?? Number.NaN, 2, 300_000, clock, 5000);
    expect(idle).toStrictEqual({ idle: true, load: 1.5, waitedMs: 10_000 });
  });

  it('свободный сразу — не ждёт', async () => {
    const clock = fakeClock();
    expect(await waitForIdle(() => 0.5, 2, 300_000, clock, 5000)).toStrictEqual({ idle: true, load: 0.5, waitedMs: 0 });
    expect(clock.sleeps).toBe(0);
  });

  it('не спадает 5 минут — отказ ровно по истечении ожидания', async () => {
    const clock = fakeClock();
    const idle = await waitForIdle(() => 6, 2, 300_000, clock, 5000);
    expect(idle).toStrictEqual({ idle: false, load: 6, waitedMs: 300_000 });
    expect(clock.sleeps).toBe(60);
  });
});
