import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GameConfig } from '../../../src/core/model/config.ts';
import { UsageTable, type TableOutcome } from '../../../tools/math/round-usage.ts';
import { simulateInProcess } from '../../../tools/math/runner.ts';
import type { SimulationPlan } from '../../../tools/math/task.ts';
import { recordUsage, recordUsageInProcess } from '../../../tools/math/usage-runner.ts';
import { STRESS_CONFIG } from '../../support/configs.ts';
import { WATCHDOG_LIMIT } from '../../support/watchdog.ts';

// Оценка таблицы по векторам использования (подбор варианта 4) обязана давать ровно то, что симулятор на тех же сидах
// с этой таблицей и этим капом: векторы записаны с недостижимым капом, кап таблицы применяет оценка. Независимый путь —
// сам движок с таблицей в конфиге (runner.ts, StatsRecorder).

const ROUNDS = 20_000;

function outcomeOfSimulator(config: GameConfig): TableOutcome {
  const plain = simulateInProcess({ config, from: 0, rounds: ROUNDS, taskSize: 5000, maxRequests: WATCHDOG_LIMIT });
  const sum = (pick: (batch: (typeof plain.batches)[number]) => number): number => plain.batches.reduce((total, batch) => total + pick(batch), 0);
  return {
    rounds: plain.rounds,
    payX100: sum((batch) => batch.payX100),
    baseX100: sum((batch) => batch.baseX100),
    featureX100: sum((batch) => batch.featureX100),
    overBet: sum((batch) => batch.overBet),
    wins: sum((batch) => batch.wins),
    features: sum((batch) => batch.features),
    caps: plain.total[config.capX100] ?? 0,
  };
}

function recorded(config: GameConfig): UsageTable {
  return new UsageTable(recordUsageInProcess({ config, from: 0, rounds: ROUNDS, taskSize: 5000, maxRequests: WATCHDOG_LIMIT }));
}

const flat = (value: number): number[][] => Array.from({ length: 7 }, () => Array.from({ length: 6 }, () => value));

describe('векторы использования: оценка таблицы = симулятор', () => {
  const game = recorded(DEFAULT_CONFIG);
  const stress = recorded(STRESS_CONFIG);

  it.each([
    ['таблица игры, кап 5000×', DEFAULT_CONFIG.paytableX100, 500_000],
    ['все клетки ровно 1× — выигрыши ровно в ставку не «выше ставки»', flat(100), 500_000],
    ['дорогая таблица, кап 2× — кап в основной игре не открывает фичу', flat(10_000), 200],
  ] as const)('конфиг игры: %s', (_, table, capX100) => {
    const config = { ...DEFAULT_CONFIG, paytableX100: table, capX100 };
    const expected = outcomeOfSimulator(config);
    expect(game.evaluate(table, capX100)).toStrictEqual(expected);
    expect(expected.wins).toBeGreaterThan(0);
    expect(expected.features).toBeGreaterThan(0);
  });

  it('выборка покрыла кап в основной игре при ядрах на сетке и выигрыш ровно в ставку', () => {
    // Контроль охвата для двух случаев выше: без них сравнение не различило бы «фичу после капа» и «≥ вместо >».
    const capped = { ...DEFAULT_CONFIG, paytableX100: flat(10_000), capX100: 200 };
    const uncappedFeatures = outcomeOfSimulator({ ...capped, capX100: 1_000_000 }).features;
    expect(outcomeOfSimulator(capped).features).toBeLessThan(uncappedFeatures);
    const exact = outcomeOfSimulator({ ...DEFAULT_CONFIG, paytableX100: flat(100) });
    expect(exact.wins - exact.overBet).toBeGreaterThan(0);
  });

  // 12 прогонов симулятора по 20 000 раундов — 2.2 с на M4, а в CI под параллельными файлами до 5.6 с: таймаут Vitest по
  // умолчанию (5 с) ронял тест (прогоны 37993637366, 37993729752); под 30 занятыми процессами локально — 11 с.
  it('property: случайная таблица и кап — оценка равна симулятору (стресс-конфиг: фича, ретриггер и кап часты)', { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.integer({ min: 0, max: 20_000 }), { minLength: 6, maxLength: 6 }), { minLength: 7, maxLength: 7 }),
        fc.constantFrom(300, 5000, 50_000),
        (table, capX100) => {
          const config = { ...STRESS_CONFIG, paytableX100: table, capX100 };
          expect(stress.evaluate(table, capX100)).toStrictEqual(outcomeOfSimulator(config));
        },
      ),
      { numRuns: 12 },
    );
  });

  it('потоки дают тот же набор, что запись без потоков', async () => {
    const plan: SimulationPlan = { config: STRESS_CONFIG, from: 0, rounds: 12_000, taskSize: 5000, maxRequests: WATCHDOG_LIMIT };
    expect(await recordUsage(plan, 3)).toStrictEqual(recordUsageInProcess(plan));
  });
});
