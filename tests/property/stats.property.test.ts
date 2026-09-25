import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EventRecorder, SeededEngine, StatsRecorder } from '../../src/core/engine/index.ts';
import { DEFAULT_CONFIG, type GameConfig } from '../../src/core/model/config.ts';
import { STRESS_CONFIG } from '../support/configs.ts';
import { verifyRound } from '../support/round-model.ts';
import { WATCHDOG_LIMIT } from '../support/watchdog.ts';

// StatsRecorder против эталонной модели и линейность выплаты по таблице — на ней стоит подбор фазы 2.

const SEED = fc.integer({ min: 0, max: 0xffffffff });
const CONFIGS: readonly [string, GameConfig][] = [
  ['стресс', STRESS_CONFIG],
  ['черновик игры', DEFAULT_CONFIG],
];

function reprice(stats: StatsRecorder, table: readonly (readonly number[])[]): number {
  const usage = new Float64Array(2 * 7 * stats.bands);
  stats.addUsageTo(usage, new Float64Array(usage.length));
  let total = 0;
  usage.forEach((mult, index) => {
    const band = index % stats.bands;
    const symbol = Math.floor(index / stats.bands) % 7;
    total += (table[symbol]?.[band] ?? Number.NaN) * mult;
  });
  return total;
}

describe.each(CONFIGS)('конфиг «%s»', (_name, config) => {
  it('факты StatsRecorder совпадают с эталонной моделью; основная игра + фича = итог', () => {
    const recorder = new EventRecorder();
    const events = new SeededEngine(config, recorder, { maxRequests: WATCHDOG_LIMIT });
    const stats = new StatsRecorder(config);
    const counted = new SeededEngine(config, stats, { maxRequests: WATCHDOG_LIMIT });
    fc.assert(
      fc.property(SEED, (seed) => {
        events.play(seed);
        counted.play(seed);
        const model = verifyRound(config, recorder.events);
        expect({
          payX100: stats.payX100,
          featured: stats.featured,
          freeSpins: stats.freeSpins,
          retriggers: stats.retriggers,
          capped: stats.capped,
          longestCascade: stats.longestCascade,
          topLevel: stats.maxLevel,
        }).toStrictEqual({
          payX100: model.payX100,
          featured: model.featured,
          freeSpins: model.freeSpins,
          retriggers: model.retriggers,
          capped: model.capped,
          longestCascade: model.longestCascade,
          topLevel: model.topLevel,
        });
        expect(stats.basePayX100 + stats.featurePayX100).toBe(stats.payX100);
        if (!model.featured) expect(stats.featurePayX100).toBe(0);
      }),
      { numRuns: 1000 },
    );
  });

  it('выплата без капа линейна по таблице: переоценка по использованию равна игре с другой таблицей', () => {
    const stats = new StatsRecorder(config);
    const engine = new SeededEngine(config, stats, { maxRequests: WATCHDOG_LIMIT });
    let compared = 0;
    // Другая таблица той же формы: исход раунда (кластеры, каскады, множители) от таблицы не зависит, меняются только выплаты.
    const tables = fc.array(fc.array(fc.integer({ min: 0, max: 5000 }), { minLength: 6, maxLength: 6 }), { minLength: 7, maxLength: 7 });
    fc.assert(
      fc.property(SEED, tables, (seed, table) => {
        engine.play(seed);
        if (stats.capped) return;
        expect(reprice(stats, config.paytableX100)).toBe(stats.payX100);
        const priced = new StatsRecorder(config);
        const other = new SeededEngine({ ...config, paytableX100: table }, priced, { maxRequests: WATCHDOG_LIMIT });
        other.play(seed);
        if (priced.capped) return;
        expect(priced.payX100).toBe(reprice(stats, table));
        compared += 1;
      }),
      { numRuns: 300 },
    );
    expect(compared).toBeGreaterThan(0);
  });
});
