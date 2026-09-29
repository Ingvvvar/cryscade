import type { RoundLease, RoundLock } from './ports.ts';

/** Замок показа раунда (§6.5): общий для вкладок профиля. */
export const ROUND_LOCK = 'cryscade-round';

/** То, что замку нужно от navigator.locks. */
export interface LockRequests {
  request(name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void> | undefined): Promise<unknown>;
}

class WebLease implements RoundLease {
  readonly lost: Promise<void>;
  readonly #release: () => void;

  constructor(release: () => void, lost: Promise<void>) {
    this.#release = release;
    this.lost = lost;
  }

  release(): void {
    this.#release();
  }
}

/**
 * RoundLock на Web Locks. Замок держится, пока ждёт промис колбэка request: release его отпускает. Отнятый замок
 * (steal) отклоняет промис request у хозяина — AbortError: это lost, а не ошибка. Снятый сигналом запрос в очереди —
 * тоже AbortError: acquire отклоняется, колбэк не зовётся. Оба отказа ловятся здесь — консоль пуста.
 */
export class WebRoundLock implements RoundLock {
  readonly #locks: LockRequests;

  constructor(locks: LockRequests) {
    this.#locks = locks;
  }

  tryAcquire(): Promise<RoundLease | null> {
    return this.#hold({ ifAvailable: true });
  }

  async acquire(signal: AbortSignal): Promise<RoundLease> {
    const lease = await this.#hold({ signal });
    if (lease === null) throw new Error('замок из очереди без замка');
    return lease;
  }

  async steal(): Promise<RoundLease> {
    const lease = await this.#hold({ steal: true });
    if (lease === null) throw new Error('перехват без замка');
    return lease;
  }

  #hold(options: LockOptions): Promise<RoundLease | null> {
    return new Promise((resolveLease, rejectLease) => {
      let granted = false;
      let markLost = (): void => undefined;
      const lost = new Promise<void>((resolve) => {
        markLost = resolve;
      });
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.#locks
        .request(ROUND_LOCK, options, (lock) => {
          if (lock === null) {
            resolveLease(null);
            return undefined;
          }
          granted = true;
          resolveLease(new WebLease(release, lost));
          return held;
        })
        .then(
          () => undefined,
          (error: unknown) => {
            if (granted) markLost();
            else rejectLease(error instanceof Error ? error : new Error(String(error)));
          },
        );
    });
  }
}
