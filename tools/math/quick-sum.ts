import { SeededEngine, SilentRecorder } from '../../src/core/engine/index.ts';
import type { GameConfig } from '../../src/core/model/config.ts';
import { SIMULATOR_MAX_REQUESTS } from './limits.ts';

/** Раундов в быстрой проверке: сиды [0, 2·10⁵), один поток. */
export const QUICK_ROUNDS = 200_000;

export interface QuickSum {
  /** Сумма выплат в сотых долях ставки — «золотая» сумма. */
  readonly payX100: number;
  readonly wins: number;
}

export function quickSum(config: GameConfig): QuickSum {
  const engine = new SeededEngine(config, new SilentRecorder(), { maxRequests: SIMULATOR_MAX_REQUESTS });
  let payX100 = 0;
  let wins = 0;
  for (let seed = 0; seed < QUICK_ROUNDS; seed++) {
    const pay = engine.play(seed);
    payX100 += pay;
    if (pay > 0) wins += 1;
  }
  return { payX100, wins };
}
