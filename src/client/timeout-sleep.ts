import type { Sleep } from './ports.ts';

/** Ожидание на таймерах среды — одинаково в браузере и в Node. */
export class TimeoutSleep implements Sleep {
  sleep(ms: number, signal?: AbortSignal): Promise<'elapsed' | 'aborted'> {
    if (signal?.aborted === true) return Promise.resolve('aborted');
    return new Promise((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve('aborted');
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve('elapsed');
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
