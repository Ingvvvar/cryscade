import type { Transport } from './ports.ts';

/** То, что транспорту нужно от Worker: в браузере — настоящий, в тестах — подставной. */
export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

/**
 * Транспорт до воркера сервера (§6.5): postMessage туда, message обратно. Воркер создаёт фабрика при первой отправке.
 * Не загрузился или упал (error) — он снят: попытки в нём потеряны и истекут по таймауту, а повтор поднимет новый
 * воркер. Сообщения снятого воркера уже никого не касаются.
 */
export class WorkerTransport implements Transport {
  readonly #create: () => WorkerLike;
  readonly #listeners = new Set<(message: unknown) => void>();
  #worker: WorkerLike | null = null;

  constructor(create: () => WorkerLike) {
    this.#create = create;
  }

  send(message: unknown): void {
    this.#current().postMessage(message);
  }

  listen(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #current(): WorkerLike {
    if (this.#worker !== null) return this.#worker;
    const worker = this.#create();
    worker.onmessage = (event) => {
      if (this.#worker !== worker) return;
      const message: unknown = event.data;
      for (const listener of [...this.#listeners]) listener(message);
    };
    worker.onerror = () => {
      if (this.#worker !== worker) return;
      this.#worker = null;
      worker.terminate();
    };
    this.#worker = worker;
    return worker;
  }
}
