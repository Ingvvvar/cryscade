import { Worker } from 'node:worker_threads';
import { SeededEngine, StatsRecorder } from '../../src/core/engine/index.ts';
import type { GameConfig } from '../../src/core/model/config.ts';
import { MathStats, type MathPlain } from '../math/stats.ts';
import { tasksOf, type SimulationPlan, type Task } from '../math/task.ts';
import { BookCollector, type CollectorPlain } from './collector.ts';

// Проход прообраза книги: та же симуляция, что у отчёта фазы 2 (сборщик MathStats), и выборки корзин. Итог не зависит
// от числа потоков: сборщик сливается точным сложением, выборки — нижние K по хешу сида.

interface PrototypePlain {
  readonly stats: MathPlain;
  readonly collector: CollectorPlain;
}

export class BookTaskRunner {
  readonly #recorder: StatsRecorder;
  readonly #engine: SeededEngine;
  readonly #stats: MathStats;
  readonly #collector: BookCollector;

  constructor(config: GameConfig, maxRequests: number, perBucket?: number) {
    this.#recorder = new StatsRecorder(config);
    this.#engine = new SeededEngine(config, this.#recorder, { maxRequests });
    this.#stats = new MathStats(config.capX100, this.#recorder.bands);
    this.#collector = new BookCollector(config.capX100, perBucket);
  }

  run(task: Task): void {
    this.#stats.startTask(task.index);
    for (let seed = task.from; seed < task.from + task.count; seed++) {
      this.#engine.play(seed);
      this.#stats.add(seed, this.#recorder, this.#engine.requests);
      this.#collector.add(seed, this.#recorder.payX100);
    }
  }

  toPlain(): PrototypePlain {
    return { stats: this.#stats.toPlain(), collector: this.#collector.toPlain() };
  }
}

function merged(plan: SimulationPlan, parts: readonly PrototypePlain[], perBucket?: number): PrototypePlain {
  const stats = new MathStats(plan.config.capX100, plan.config.sizeBands.length);
  const collector = new BookCollector(plan.config.capX100, perBucket);
  for (const part of parts) {
    stats.merge(part.stats);
    collector.merge(part.collector);
  }
  return { stats: stats.toPlain(), collector: collector.toPlain() };
}

export function prototypeInProcess(plan: SimulationPlan, perBucket?: number): PrototypePlain {
  const runner = new BookTaskRunner(plan.config, plan.maxRequests, perBucket);
  for (const task of tasksOf(plan)) runner.run(task);
  return merged(plan, [runner.toPlain()], perBucket);
}

export interface BookWorkerInit {
  readonly config: GameConfig;
  readonly maxRequests: number;
  readonly perBucket?: number;
}

export type ToBookWorker = { readonly type: 'task'; readonly task: Task } | { readonly type: 'finish' };
type FromBookWorker = { readonly type: 'done' } | { readonly type: 'result'; readonly plain: PrototypePlain };

/** В потоках. Ошибка любого раунда роняет весь прогон: сиды не пропускаются. */
export async function prototype(plan: SimulationPlan, threads: number, perBucket?: number): Promise<PrototypePlain> {
  if (!Number.isInteger(threads) || threads < 1) throw new RangeError(`потоков: ${String(threads)}`);
  const queue = tasksOf(plan);
  const parts: PrototypePlain[] = [];
  const init: BookWorkerInit = { config: plan.config, maxRequests: plan.maxRequests, ...(perBucket === undefined ? {} : { perBucket }) };
  const workers = Array.from({ length: Math.min(threads, queue.length) }, () => new Worker(new URL('./worker.ts', import.meta.url), { workerData: init }));
  const runs = workers.map(
    (worker) =>
      new Promise<void>((resolve, reject) => {
        const feed = (): void => {
          const task = queue.shift();
          const message: ToBookWorker = task === undefined ? { type: 'finish' } : { type: 'task', task };
          worker.postMessage(message);
        };
        worker.on('message', (message: FromBookWorker) => {
          if (message.type === 'done') {
            feed();
            return;
          }
          parts.push(message.plain);
          resolve();
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code !== 0) reject(new Error(`поток книги вышел с кодом ${String(code)}`));
        });
        feed();
      }),
  );
  try {
    await Promise.all(runs);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
  return merged(plan, parts, perBucket);
}
