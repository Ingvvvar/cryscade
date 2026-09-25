import { SeededEngine, StatsRecorder } from '../../src/core/engine/index.ts';
import type { GameConfig } from '../../src/core/model/config.ts';
import { MathStats } from './stats.ts';

// Одна задача симуляции — один и тот же код в потоке и в прогоне без потоков: итог обязан совпадать.

export interface Task {
  readonly index: number;
  readonly from: number;
  readonly count: number;
}

export interface SimulationPlan {
  readonly config: GameConfig;
  /** Первый сид и число раундов: сиды [from, from + rounds) — целые u32. */
  readonly from: number;
  readonly rounds: number;
  /** Сидов в задаче; число задач от числа потоков не зависит. */
  readonly taskSize: number;
  /** Порог сторожа — задаёт вызывающий (§4.7). */
  readonly maxRequests: number;
}

export function tasksOf(plan: SimulationPlan): Task[] {
  const { from, rounds, taskSize } = plan;
  if (!Number.isInteger(from) || from < 0 || !Number.isInteger(rounds) || rounds < 1 || from + rounds > 2 ** 32) {
    throw new RangeError(`сиды [${String(from)}, ${String(from + rounds)}) вне u32`);
  }
  if (!Number.isInteger(taskSize) || taskSize < 1) throw new RangeError(`размер задачи: ${String(taskSize)}`);
  const tasks: Task[] = [];
  for (let index = 0; index * taskSize < rounds; index++) {
    const start = from + index * taskSize;
    tasks.push({ index, from: start, count: Math.min(taskSize, from + rounds - start) });
  }
  return tasks;
}

/** Движок, рекордер и сборщик одного исполнителя. */
export class TaskRunner {
  readonly #stats: StatsRecorder;
  readonly #engine: SeededEngine;
  readonly #aggregate: MathStats;

  constructor(config: GameConfig, maxRequests: number) {
    this.#stats = new StatsRecorder(config);
    this.#engine = new SeededEngine(config, this.#stats, { maxRequests });
    this.#aggregate = new MathStats(config.capX100, this.#stats.bands);
  }

  get aggregate(): MathStats {
    return this.#aggregate;
  }

  run(task: Task): void {
    this.#aggregate.startTask(task.index);
    for (let seed = task.from; seed < task.from + task.count; seed++) {
      this.#engine.play(seed);
      this.#aggregate.add(seed, this.#stats, this.#engine.requests);
    }
  }
}
