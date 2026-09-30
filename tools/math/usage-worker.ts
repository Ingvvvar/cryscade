// Поток записи векторов использования: берёт задачи по одной, в конце отдаёт свой набор простыми данными.
import { parentPort, workerData } from 'node:worker_threads';
import { UsageTaskRunner, type ToUsageWorker, type UsageWorkerInit } from './usage-runner.ts';

const port = parentPort;
if (port === null) throw new Error('usage-worker.ts запускается только как поток');
const init = workerData as UsageWorkerInit;
const runner = new UsageTaskRunner(init.config, init.maxRequests);

port.on('message', (message: ToUsageWorker) => {
  if (message.type === 'task') {
    runner.run(message.task);
    port.postMessage({ type: 'done' });
    return;
  }
  port.postMessage({ type: 'result', plain: runner.set.toPlain() });
  port.close();
});
