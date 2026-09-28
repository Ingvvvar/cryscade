import type { Lock } from './ports.ts';

/**
 * Замок в памяти: на каждое имя — очередь промисов, задачи идут по одной в порядке прихода, как у Web Locks.
 * Держит один контекст: воркер без Web Locks и тесты, где два сервера делят один экземпляр.
 * Задача, упавшая с ошибкой, отпускает замок так же, как успешная.
 */
export class MemoryLock implements Lock {
  readonly #tails = new Map<string, Promise<void>>();

  withLock<T>(name: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(name) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(name, tail);
    void tail.then(() => {
      if (this.#tails.get(name) === tail) this.#tails.delete(name);
    });
    return run;
  }
}
