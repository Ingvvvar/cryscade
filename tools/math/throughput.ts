import { SeededEngine, SilentRecorder } from '../../src/core/engine/index.ts';
import type { GameConfig } from '../../src/core/model/config.ts';
import { TaskRunner } from './task.ts';

// Пропускная способность одного ядра: тихий режим и путь симулятора (StatsRecorder и сборщик).
// Прогрев, затем RUNS замеров; в отчёт — худший.

const WARMUP = 50_000;
const ROUNDS = 200_000;
const RUNS = 5;

function worstRate(play: (seed: number) => void): number {
  for (let seed = 0; seed < WARMUP; seed++) play(seed);
  let worst = Number.POSITIVE_INFINITY;
  for (let run = 0; run < RUNS; run++) {
    const from = WARMUP + run * ROUNDS;
    const started = performance.now();
    for (let seed = from; seed < from + ROUNDS; seed++) play(seed);
    worst = Math.min(worst, ROUNDS / ((performance.now() - started) / 1000));
  }
  return worst;
}

export interface Throughput {
  readonly silentPerCore: number;
  readonly statsPerCore: number;
}

export function measureThroughput(config: GameConfig, maxRequests: number): Throughput {
  const silent = new SeededEngine(config, new SilentRecorder(), { maxRequests });
  const runner = new TaskRunner(config, maxRequests);
  return {
    silentPerCore: worstRate((seed) => silent.play(seed)),
    statsPerCore: worstRate((seed) => {
      runner.run({ index: 0, from: seed, count: 1 });
    }),
  };
}
