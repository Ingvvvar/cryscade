import { describe, expect, it } from 'vitest';
import { EventRecorder, SeededEngine } from '../../../src/core/engine/index.ts';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { FORCED_SEEDS } from '../../../src/ui/forced-rounds.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';

// Сиды принудительных раундов: сиды фикстур — те, что в файлах фикстур; уровни большого выигрыша — движком заново:
// выигрыш раунда сида в порогах §8.4 (20×, 50×, 100×, кап 5000×), без правил показа.

function payX100(seed: number): number {
  return new SeededEngine(DEFAULT_CONFIG, new EventRecorder(), { maxRequests: 1_000_000 }).play(seed);
}

describe('FORCED_SEEDS', () => {
  it.each([
    ['loss', 'loss'],
    ['smallWin', 'small-win'],
    ['baseWin', 'base-win'],
    ['cascade', 'cascade-3'],
    ['multiplier', 'multiplier-8'],
    ['feature', 'feature-start'],
    ['retrigger', 'retrigger'],
    ['maxWin', 'biggest'],
  ] as const)('%s — сид фикстуры %s', (name, fixture) => {
    expect(FORCED_SEEDS[name]).toBe(fixtureRound(fixture).seed);
  });

  it.each([
    ['bigWin1', 2000, 5000],
    ['bigWin2', 5000, 10_000],
    ['bigWin3', 10_000, 500_000],
  ] as const)('%s — выигрыш раунда от %d до %d сотых ставки, без капа', (name, from, below) => {
    const pay = payX100(FORCED_SEEDS[name]);
    expect(pay).toBeGreaterThanOrEqual(from);
    expect(pay).toBeLessThan(below);
  });

  it('maxWin — кап 5000×', () => {
    expect(payX100(FORCED_SEEDS.maxWin)).toBe(500_000);
  });
});
