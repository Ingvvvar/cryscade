import { Worker } from 'node:worker_threads';
import { SeededEngine } from '../../src/core/engine/index.ts';
import type { GameConfig } from '../../src/core/model/config.ts';
import { UNCAPPED_X100, UsageRecorder, UsageSet, type UsagePlain } from './round-usage.ts';
import { tasksOf, type SimulationPlan, type Task } from './task.ts';

// Запись векторов использования (round-usage.ts) на диапазоне сидов — в потоках или без них. Кап записи
// недостижимый: вектор раунда полный, кап таблицы применяет оценка. Итог не зависит от числа потоков: вектор —
// функция конфига и сида, набор сливается сложением счётов.

/** Конфиг записи: веса и правила игры, кап недостижимый. Таблица на векторы не влияет. */
function uncapped(config: GameConfig): GameConfig {
  return { ...config, capX100: UNCAPPED_X100 };
}

/** Исполнитель: движок и рекордер записи, свой набор векторов. */
export class UsageTaskRunner {
  readonly #recorder: UsageRecorder;
  readonly #engine: SeededEngine;
  readonly #set: UsageSet;

  constructor(config: GameConfig, maxRequests: number) {
    this.#recorder = new UsageRecorder(config);
    this.#engine = new SeededEngine(uncapped(config), this.#recorder, { maxRequests });
    this.#set = new UsageSet(config.sizeBands.length);
  }

  get set(): UsageSet {
    return this.#set;
  }

  run(task: Task): void {
    for (let seed = task.from; seed < task.from + task.count; seed++) {
      this.#engine.play(seed);
      this.#set.add(this.#recorder.key);
    }
  }
}

export function recordUsageInProcess(plan: SimulationPlan): UsagePlain {
  const runner = new UsageTaskRunner(plan.config, plan.maxRequests);
  for (const task of tasksOf(plan)) runner.run(task);
  const merged = new UsageSet(plan.config.sizeBands.length);
  merged.merge(runner.set.toPlain());
  return merged.toPlain();
}

export interface UsageWorkerInit {
  readonly config: GameConfig;
  readonly maxRequests: number;
}

export type ToUsageWorker = { readonly type: 'task'; readonly task: Task } | { readonly type: 'finish' };
type FromUsageWorker = { readonly type: 'done' } | { readonly type: 'result'; readonly plain: UsagePlain };

/** В потоках. Ошибка любого раунда роняет всю запись: сиды не пропускаются. */
export async function recordUsage(plan: SimulationPlan, threads: number): Promise<UsagePlain> {
  if (!Number.isInteger(threads) || threads < 1) throw new RangeError(`потоков: ${String(threads)}`);
  const queue = tasksOf(plan);
  const merged = new UsageSet(plan.config.sizeBands.length);
  const init: UsageWorkerInit = { config: plan.config, maxRequests: plan.maxRequests };
  const workers = Array.from(
    { length: Math.min(threads, queue.length) },
    () => new Worker(new URL('./usage-worker.ts', import.meta.url), { workerData: init }),
  );
  const runs = workers.map(
    (worker) =>
      new Promise<void>((resolve, reject) => {
        const feed = (): void => {
          const task = queue.shift();
          const message: ToUsageWorker = task === undefined ? { type: 'finish' } : { type: 'task', task };
          worker.postMessage(message);
        };
        worker.on('message', (message: FromUsageWorker) => {
          if (message.type === 'done') {
            feed();
            return;
          }
          merged.merge(message.plain);
          resolve();
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code !== 0) reject(new Error(`поток записи вышел с кодом ${String(code)}`));
        });
        feed();
      }),
  );
  try {
    await Promise.all(runs);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
  return merged.toPlain();
}
