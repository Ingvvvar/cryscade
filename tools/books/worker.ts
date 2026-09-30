// Поток прообраза книги: берёт задачи по одной, в конце отдаёт сборщик и выборки простыми данными.
import { parentPort, workerData } from 'node:worker_threads';
import { BookTaskRunner, type BookWorkerInit, type ToBookWorker } from './runner.ts';

const port = parentPort;
if (port === null) throw new Error('books/worker.ts запускается только как поток');
const init = workerData as BookWorkerInit;
const runner = new BookTaskRunner(init.config, init.maxRequests, init.perBucket);

port.on('message', (message: ToBookWorker) => {
  if (message.type === 'task') {
    runner.run(message.task);
    port.postMessage({ type: 'done' });
    return;
  }
  const plain = runner.toPlain();
  const buffers = [plain.stats.total, plain.stats.base, plain.stats.feature].map((array) => array.buffer as ArrayBuffer);
  port.postMessage({ type: 'result', plain }, buffers);
  port.close();
});
