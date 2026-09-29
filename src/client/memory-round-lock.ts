import type { RoundLease, RoundLock } from './ports.ts';

/** Замок во владении: release отпускает, lose — замок отняли. После любого из них он больше ничего не делает. */
class MemoryLease implements RoundLease {
  readonly lost: Promise<void>;
  readonly #onRelease: () => void;
  readonly #markLost: () => void;
  #done = false;

  constructor(onRelease: () => void) {
    this.#onRelease = onRelease;
    let markLost = (): void => undefined;
    this.lost = new Promise<void>((resolve) => {
      markLost = resolve;
    });
    this.#markLost = markLost;
  }

  release(): void {
    if (this.#done) return;
    this.#done = true;
    this.#onRelease();
  }

  lose(): void {
    if (this.#done) return;
    this.#done = true;
    this.#markLost();
  }
}

interface Waiter {
  readonly grant: (lease: MemoryLease) => void;
}

/**
 * Замок раунда в памяти — с семантикой Web Locks: эксклюзивный, очередь по приходу, отмена сигналом действует только
 * до выдачи, steal отнимает у держателя и оставляет очередь как есть. Отпущенный замок сразу уходит первому в очереди,
 * поэтому свободен он, только когда очередь пуста, и ifAvailable её не обгоняет. Прод-код:
 * замок вкладки, когда хранилище недоступно и вкладки независимы. В тестах один экземпляр на несколько контроллеров —
 * общий замок вкладок.
 */
export class MemoryRoundLock implements RoundLock {
  readonly #queue: Waiter[] = [];
  #holder: MemoryLease | null = null;

  tryAcquire(): Promise<RoundLease | null> {
    return Promise.resolve(this.#holder === null ? this.#grant() : null);
  }

  acquire(signal: AbortSignal): Promise<RoundLease> {
    if (signal.aborted) return Promise.reject(new DOMException('запрос замка снят', 'AbortError'));
    if (this.#holder === null) return Promise.resolve(this.#grant());
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.#queue.indexOf(waiter);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        reject(new DOMException('запрос замка снят', 'AbortError'));
      };
      const waiter: Waiter = {
        grant: (lease) => {
          signal.removeEventListener('abort', onAbort);
          resolve(lease);
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  steal(): Promise<RoundLease> {
    this.#holder?.lose();
    this.#holder = null;
    return Promise.resolve(this.#grant());
  }

  #grant(): MemoryLease {
    const lease = new MemoryLease(() => {
      this.#released();
    });
    this.#holder = lease;
    return lease;
  }

  /** Отпускает только держатель: отнятый или уже отпущенный замок release не передаёт (MemoryLease). */
  #released(): void {
    this.#holder = null;
    this.#queue.shift()?.grant(this.#grant());
  }
}
