import { describe, expect, it } from 'vitest';
import { MemoryRoundLock, type RoundLease } from '../../../src/client/index.ts';

// Замок раунда в памяти держит семантику Web Locks, снятую пробами шага Б в Chrome 153: steal отнимает сразу, у
// держателя промис отклоняется, очередь остаётся; снятие запроса в очереди — AbortError, колбэк не вызывается;
// снятие после выдачи ни на что не влияет.

/** Сбылся ли промис — после всех микрозадач. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

async function held(lock: MemoryRoundLock): Promise<boolean> {
  const probe = await lock.tryAcquire();
  probe?.release();
  return probe === null;
}

describe('MemoryRoundLock', () => {
  it('ifAvailable: свободен — выдан, занят — null', async () => {
    const lock = new MemoryRoundLock();
    const first = await lock.tryAcquire();
    expect(first).not.toBeNull();
    expect(await lock.tryAcquire()).toBeNull();
    first?.release();
    expect(await held(lock)).toBe(false);
  });

  it('очередь — по приходу; ifAvailable её не обгоняет', async () => {
    const lock = new MemoryRoundLock();
    const holder = await lock.tryAcquire();
    const order: string[] = [];
    const a = lock.acquire(new AbortController().signal).then((lease) => {
      order.push('a');
      return lease;
    });
    const b = lock.acquire(new AbortController().signal).then((lease) => {
      order.push('b');
      return lease;
    });
    expect(await settled(a)).toBe(false);
    holder?.release();
    const leaseA = await a;
    expect(order).toStrictEqual(['a']);
    expect(await lock.tryAcquire()).toBeNull();
    leaseA.release();
    (await b).release();
    expect(order).toStrictEqual(['a', 'b']);
    expect(await held(lock)).toBe(false);
  });

  it('снятие запроса в очереди — AbortError, замок ему не выдаётся', async () => {
    const lock = new MemoryRoundLock();
    const holder = await lock.tryAcquire();
    const cancel = new AbortController();
    const queued = lock.acquire(cancel.signal);
    cancel.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    holder?.release();
    expect(await held(lock)).toBe(false);
  });

  it('снятие после выдачи ни на что не влияет; уже снятый сигнал — отказ сразу', async () => {
    const lock = new MemoryRoundLock();
    const cancel = new AbortController();
    const lease = await lock.acquire(cancel.signal);
    cancel.abort();
    expect(await held(lock)).toBe(true);
    lease.release();
    await expect(lock.acquire(cancel.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await held(lock)).toBe(false);
  });

  it('steal: держатель теряет замок, крадущий получает сразу, очередь остаётся за ним', async () => {
    const lock = new MemoryRoundLock();
    const victim = (await lock.tryAcquire()) as RoundLease;
    const queued = lock.acquire(new AbortController().signal);
    const thief = await lock.steal();
    expect(await settled(victim.lost)).toBe(true);
    expect(await settled(queued)).toBe(false);
    // Отпустить отнятое — ничего: замок у крадущего.
    victim.release();
    expect(await held(lock)).toBe(true);
    thief.release();
    const next = await queued;
    expect(await held(lock)).toBe(true);
    next.release();
    expect(await held(lock)).toBe(false);
  });

  it('release — не потеря: lost не сбывается; повторный release ничего не делает', async () => {
    const lock = new MemoryRoundLock();
    const first = (await lock.tryAcquire()) as RoundLease;
    first.release();
    const second = (await lock.tryAcquire()) as RoundLease;
    first.release();
    expect(await held(lock)).toBe(true);
    expect(await settled(first.lost)).toBe(false);
    second.release();
  });

  it('steal свободного замка — просто выдача', async () => {
    const lock = new MemoryRoundLock();
    const lease = await lock.steal();
    expect(await held(lock)).toBe(true);
    lease.release();
    expect(await held(lock)).toBe(false);
  });
});
