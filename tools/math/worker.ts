// Поток симулятора: берёт задачи по одной, в конце отдаёт сборщик простыми данными.
import { parentPort, workerData } from 'node:worker_threads';
import type { GameConfig } from '../../src/core/model/config.ts';
import { TaskRunner, type Task } from './task.ts';

export interface WorkerInit {
  readonly config: GameConfig;
  readonly maxRequests: number;
}

export type ToWorker = { readonly type: 'task'; readonly task: Task } | { readonly type: 'finish' };

const port = parentPort;
if (port === null) throw new Error('worker.ts запускается только как поток');
const init = workerData as WorkerInit;
const runner = new TaskRunner(init.config, init.maxRequests);

port.on('message', (message: ToWorker) => {
  if (message.type === 'task') {
    runner.run(message.task);
    port.postMessage({ type: 'done' });
    return;
  }
  const plain = runner.aggregate.toPlain();
  const buffers = [plain.total, plain.base, plain.feature].map((array) => array.buffer as ArrayBuffer);
  port.postMessage({ type: 'result', plain }, buffers);
  port.close();
});
