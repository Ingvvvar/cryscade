import { Worker } from 'node:worker_threads';
import { MathStats, type MathPlain } from './stats.ts';
import { TaskRunner, tasksOf, type SimulationPlan } from './task.ts';
import type { ToWorker, WorkerInit } from './worker.ts';

// Симулятор: диапазон сидов режется на задачи фиксированного размера, потоки берут их из очереди.
// Итог не зависит от числа потоков: раунд — функция конфига и сида, задачи не зависят от потоков,
// сборщик сливается точным сложением целых (stats.ts).

type FromWorker = { readonly type: 'done' } | { readonly type: 'result'; readonly plain: MathPlain };

function emptyStats(plan: SimulationPlan): MathStats {
  return new MathStats(plan.config.capX100, plan.config.sizeBands.length);
}

/** Без потоков — для тестов и коротких прогонов. */
export function simulateInProcess(plan: SimulationPlan): MathPlain {
  const runner = new TaskRunner(plan.config, plan.maxRequests);
  for (const task of tasksOf(plan)) runner.run(task);
  const merged = emptyStats(plan);
  merged.merge(runner.aggregate.toPlain());
  return merged.toPlain();
}

/** В потоках. Ошибка любого раунда — сторожа или движка — роняет весь прогон: сиды не пропускаются. */
export async function simulate(plan: SimulationPlan, threads: number): Promise<MathPlain> {
  if (!Number.isInteger(threads) || threads < 1) throw new RangeError(`потоков: ${String(threads)}`);
  const queue = tasksOf(plan);
  const merged = emptyStats(plan);
  const init: WorkerInit = { config: plan.config, maxRequests: plan.maxRequests };
  const workers = Array.from({ length: Math.min(threads, queue.length) }, () => new Worker(new URL('./worker.ts', import.meta.url), { workerData: init }));

  const runs = workers.map(
    (worker) =>
      new Promise<void>((resolve, reject) => {
        const feed = (): void => {
          const task = queue.shift();
          const message: ToWorker = task === undefined ? { type: 'finish' } : { type: 'task', task };
          worker.postMessage(message);
        };
        worker.on('message', (message: FromWorker) => {
          if (message.type === 'done') {
            feed();
            return;
          }
          merged.merge(message.plain);
          resolve();
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code !== 0) reject(new Error(`поток симулятора вышел с кодом ${String(code)}`));
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
