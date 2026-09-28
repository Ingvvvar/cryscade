import { describe, expect, it } from 'vitest';
import { MemoryLock } from '../../../src/server/index.ts';

// Замок в памяти ведёт себя как Web Locks в режиме exclusive: задачи одного имени не пересекаются и идут в порядке
// прихода, упавшая задача отпускает замок, разные имена друг друга не ждут.

/** Промис, который тест отпускает сам. */
function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('MemoryLock', () => {
  it('задачи одного имени не пересекаются и идут в порядке прихода', async () => {
    const lock = new MemoryLock();
    const log: string[] = [];
    const first = gate();
    const a = lock.withLock('w', async () => {
      log.push('a:start');
      await first.promise;
      log.push('a:end');
      return 'a';
    });
    const b = lock.withLock('w', () => {
      log.push('b');
      return Promise.resolve('b');
    });
    const c = lock.withLock('w', () => {
      log.push('c');
      return Promise.resolve('c');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toStrictEqual(['a:start']);
    first.open();
    expect(await Promise.all([a, b, c])).toStrictEqual(['a', 'b', 'c']);
    expect(log).toStrictEqual(['a:start', 'a:end', 'b', 'c']);
  });

  it('упавшая задача отдаёт ошибку вызывающему и отпускает замок', async () => {
    const lock = new MemoryLock();
    const failed = lock.withLock('w', () => Promise.reject(new Error('сбой')));
    const next = lock.withLock('w', () => Promise.resolve('дальше'));
    await expect(failed).rejects.toThrow('сбой');
    expect(await next).toBe('дальше');
  });

  it('задача, бросившая синхронно, тоже отпускает замок', async () => {
    const lock = new MemoryLock();
    const failed = lock.withLock('w', () => {
      throw new Error('сразу');
    });
    await expect(failed).rejects.toThrow('сразу');
    expect(await lock.withLock('w', () => Promise.resolve(1))).toBe(1);
  });

  it('разные имена друг друга не ждут', async () => {
    const lock = new MemoryLock();
    const held = gate();
    const log: string[] = [];
    const wallet = lock.withLock('cryscade-wallet', async () => {
      await held.promise;
      log.push('wallet');
    });
    await lock.withLock('cryscade-round', () => {
      log.push('round');
      return Promise.resolve();
    });
    expect(log).toStrictEqual(['round']);
    held.open();
    await wallet;
    expect(log).toStrictEqual(['round', 'wallet']);
  });

  it('после освобождения замок снова берётся сразу', async () => {
    const lock = new MemoryLock();
    await lock.withLock('w', () => Promise.resolve());
    const log: string[] = [];
    const again = lock.withLock('w', () => {
      log.push('снова');
      return Promise.resolve();
    });
    await again;
    expect(log).toStrictEqual(['снова']);
  });
});
