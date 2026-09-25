import { describe, expect, it } from 'vitest';
import { verdict } from '../../../tools/math/speed-verdict.ts';

// Решение замера скорости: число пишется, только если нагрузка не выше порога и до, и после замера.
// Живой положительный контроль под искусственной нагрузкой — `node tools/math/speed.ts --control`.

const SPEED = { silentPerCore: 265_000.4, statsPerCore: 240_000.6 };

describe('замер скорости и нагрузка стенда', () => {
  it('свободный стенд — число пишется вместе с нагрузкой', () => {
    const result = verdict({ before: 0.8, after: 1.4, threshold: 2 }, SPEED, 'Apple M4.');
    expect(result.measured).toBe(true);
    expect(result.text).toContain('тихий режим 265');
    expect(result.text).toContain('нагрузка 0.80 до и 1.40 после при пороге 2.00');
  });

  it('ровно на пороге — ещё свободен', () => {
    expect(verdict({ before: 2, after: 2, threshold: 2 }, SPEED, '').measured).toBe(true);
  });

  it.each([
    ['занят до замера', { before: 11.74, after: Number.NaN, threshold: 2 }, null],
    ['занят до замера, даже если число есть', { before: 2.01, after: 1, threshold: 2 }, SPEED],
    ['освободился поздно: занят после замера', { before: 1, after: 2.5, threshold: 2 }, SPEED],
    ['нагрузка после неизвестна', { before: 1, after: Number.NaN, threshold: 2 }, SPEED],
    ['замера нет', { before: 1, after: 1, threshold: 2 }, null],
  ])('%s — «стенд занят», числа нет', (_name, load, speed) => {
    const result = verdict(load, speed, 'Apple M4.');
    expect(result.measured).toBe(false);
    expect(result.text).toMatch(/^Стенд занят: нагрузка \d+\.\d\d до/);
    expect(result.text).not.toContain('раундов/с');
  });
});
