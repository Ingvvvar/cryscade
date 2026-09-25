import { describe, expect, it } from 'vitest';
import { WatchdogError } from '../../../src/core/engine/index.ts';
import { computeReport, renderMarkdown } from '../../../tools/math/report.ts';
import { simulate, simulateInProcess } from '../../../tools/math/runner.ts';
import { MathStats, type MathPlain } from '../../../tools/math/stats.ts';
import { tasksOf, type SimulationPlan } from '../../../tools/math/task.ts';
import { STRESS_CONFIG, SUPERCRITICAL_CONFIG } from '../../support/configs.ts';
import { WATCHDOG_LIMIT } from '../../support/watchdog.ts';

// Итог симулятора не зависит от числа потоков: задачи от потоков не зависят, сборщик сливается точным сложением.

const PLAN: SimulationPlan = { config: STRESS_CONFIG, from: 0, rounds: 40_000, taskSize: 5000, maxRequests: WATCHDOG_LIMIT };

const META = { from: 0, threads: 0, taskSize: 5000, maxRequests: WATCHDOG_LIMIT, seconds: 0, environment: '', throughput: null };
const markdown = (plain: MathPlain): string => renderMarkdown(computeReport(plain, PLAN.config), PLAN.config, META);
function withoutBatches(plain: MathPlain): Record<string, unknown> {
  return Object.fromEntries(Object.entries(plain).filter(([key]) => key !== 'batches'));
}

describe('симулятор', () => {
  const reference = simulateInProcess(PLAN);

  it('прогон покрыл фичу, ретриггер и кап — иначе сравнивать нечего', () => {
    const report = computeReport(reference, PLAN.config);
    expect(reference.rounds).toBe(40_000);
    expect(report.features).toBeGreaterThan(0);
    expect(reference.retriggers).toBeGreaterThan(0);
    expect(report.caps).toBeGreaterThan(0);
    expect(reference.batches.map((batch) => batch.index)).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it.each([1, 2, 3])('%i потока дают побайтно тот же итог, что прогон без потоков', async (threads) => {
    const threaded = await simulate(PLAN, threads);
    expect(threaded).toStrictEqual(reference);
    expect(markdown(threaded)).toBe(markdown(reference));
  });

  it('использование при капе: Σ таблица × (всё − при капе) = Σ выплат раундов без капа', () => {
    const report = computeReport(reference, PLAN.config);
    const bands = PLAN.config.sizeBands.length;
    let uncappedRounds = 0;
    reference.usage.forEach((mult, index) => {
      const band = index % bands;
      const symbol = Math.floor(index / bands) % 7;
      uncappedRounds += (PLAN.config.paytableX100[symbol]?.[band] ?? Number.NaN) * (mult - (reference.usageCapped[index] ?? 0));
    });
    let paid = 0;
    reference.total.forEach((rounds, pay) => (paid += pay * rounds));
    expect(report.caps).toBeGreaterThan(0);
    expect(uncappedRounds).toBe(paid - report.caps * PLAN.config.capX100);
  });

  it('размер задачи меняет только разбиение на пакеты', async () => {
    const other = await simulate({ ...PLAN, taskSize: 7919 }, 3);
    expect(withoutBatches(other)).toStrictEqual(withoutBatches(reference));
    expect(other.batches).toHaveLength(Math.ceil(40_000 / 7919));
  });

  it('надкритичный раунд роняет весь прогон с сидом — сиды не пропускаются', async () => {
    const plan: SimulationPlan = { config: SUPERCRITICAL_CONFIG, from: 0, rounds: 20, taskSize: 5, maxRequests: WATCHDOG_LIMIT };
    await expect(simulate(plan, 2)).rejects.toThrow(/сидом \d+ сделал больше 100000 запросов/);
    expect(() => simulateInProcess(plan)).toThrow(WatchdogError);
  });

  it('сиды — только u32, задача — не пустая', () => {
    expect(() => tasksOf({ ...PLAN, from: 2 ** 32 - 10, rounds: 11 })).toThrow(RangeError);
    expect(() => tasksOf({ ...PLAN, from: -1 })).toThrow(RangeError);
    expect(() => tasksOf({ ...PLAN, taskSize: 0 })).toThrow(RangeError);
    expect(tasksOf({ ...PLAN, from: 2 ** 32 - 10, rounds: 10, taskSize: 4 })).toStrictEqual([
      { index: 0, from: 2 ** 32 - 10, count: 4 },
      { index: 1, from: 2 ** 32 - 6, count: 4 },
      { index: 2, from: 2 ** 32 - 2, count: 2 },
    ]);
  });

  it('слияние вне точных целых — ошибка, а не молча неточная сумма', () => {
    const stats = new MathStats(PLAN.config.capX100, PLAN.config.sizeBands.length);
    stats.merge(reference);
    expect(() => {
      stats.merge({ ...reference, rounds: Number.MAX_SAFE_INTEGER });
    }).toThrow(RangeError);
    const hot = Float64Array.from(reference.total);
    hot[0] = Number.MAX_SAFE_INTEGER;
    const fresh = new MathStats(PLAN.config.capX100, PLAN.config.sizeBands.length);
    fresh.merge(reference);
    expect(() => {
      fresh.merge({ ...reference, total: hot });
    }).toThrow(RangeError);
  });
});
