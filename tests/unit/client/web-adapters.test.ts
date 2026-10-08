import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BroadcastTabChannel, UuidKeys, WebRoundLock, WorkerTransport, type LockRequests, type WorkerLike } from '../../../src/client/index.ts';

// Браузерные адаптеры клиента на подставных Worker, LockManager и EventTarget. Настоящие — в e2e: перехват, очередь,
// две вкладки. Здесь — логика самих адаптеров: перезапуск упавшего воркера, выдача, очередь, перехват и отказы замка.

/**
 * Событие error воркера. Глобального ErrorEvent в Node 24 нет (появился в v25.0.0; CI — на 24), Event есть: поля —
 * пустые, транспорт их не читает.
 */
class WorkerErrorEvent extends Event implements ErrorEvent {
  readonly colno = 0;
  readonly error: unknown = null;
  readonly filename = '';
  readonly lineno = 0;
  readonly message = '';
}

/** Подставной воркер: что ему прислали, и ручки message и error. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  answer(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  crash(): void {
    this.onerror?.(new WorkerErrorEvent('error'));
  }
}

describe('WorkerTransport', () => {
  it('воркер создаётся первой отправкой и дальше тот же; ответы — слушателям, отписка работает', () => {
    const workers: FakeWorker[] = [];
    const transport = new WorkerTransport(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    expect(workers).toHaveLength(0);
    const heard: unknown[] = [];
    const unlisten = transport.listen((message) => heard.push(message));
    transport.send('a');
    transport.send('b');
    expect(workers).toHaveLength(1);
    expect(workers[0]?.sent).toStrictEqual(['a', 'b']);
    workers[0]?.answer(1);
    unlisten();
    workers[0]?.answer(2);
    expect(heard).toStrictEqual([1]);
  });

  it('упал или не загрузился — снят и остановлен; следующая отправка поднимает новый; поздний ответ старого — мимо', () => {
    const workers: FakeWorker[] = [];
    const transport = new WorkerTransport(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const heard: unknown[] = [];
    transport.listen((message) => heard.push(message));
    transport.send('a');
    const first = workers[0];
    first?.crash();
    expect(first?.terminated).toBe(true);
    transport.send('b');
    expect(workers).toHaveLength(2);
    expect(workers[1]?.sent).toStrictEqual(['b']);
    first?.answer('поздно');
    first?.crash();
    workers[1]?.answer('новый');
    expect(heard).toStrictEqual(['новый']);
    expect(workers[1]?.terminated).toBe(false);
  });
});

/**
 * Подставной LockManager одного имени с семантикой Web Locks (пробы шага Б в Chrome 153): ifAvailable — null, если
 * занят; очередь по приходу, сигнал снимает ждущий запрос AbortError без вызова колбэка; steal отклоняет промис
 * хозяина AbortError и выдаёт замок сразу; замок держится, пока ждёт промис колбэка.
 */
class FakeLocks implements LockRequests {
  readonly calls: number[] = [];
  #held: { readonly reject: (error: Error) => void } | null = null;
  readonly #queue: { readonly grant: () => void; readonly abort: (error: Error) => void }[] = [];
  #calls = 0;

  request(_name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void> | undefined): Promise<unknown> {
    this.#calls += 1;
    const call = this.#calls;
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        this.calls.push(call);
        let settled = false;
        this.#held = {
          reject: (error) => {
            settled = true;
            reject(error);
          },
        };
        const lock: Lock = { name: 'cryscade-round', mode: 'exclusive' };
        void Promise.resolve(callback(lock)).then(() => {
          if (settled) return;
          this.#held = null;
          resolve(undefined);
          this.#queue.shift()?.grant();
        });
      };
      if (options.steal === true) {
        this.#held?.reject(new DOMException("Lock broken by another request with the 'steal' option.", 'AbortError'));
        grant();
        return;
      }
      if (this.#held === null) {
        grant();
        return;
      }
      if (options.ifAvailable === true) {
        void Promise.resolve(callback(null)).then(() => {
          resolve(undefined);
        });
        return;
      }
      const entry = { grant, abort: reject };
      this.#queue.push(entry);
      options.signal?.addEventListener('abort', () => {
        const index = this.#queue.indexOf(entry);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        reject(new DOMException('The request was aborted.', 'AbortError'));
      });
    });
  }
}

describe('WebRoundLock', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('ifAvailable: свободен — замок, занят — null; release отпускает, lost при этом не сбывается', async () => {
    const lock = new WebRoundLock(new FakeLocks());
    const lease = await lock.tryAcquire();
    expect(lease).not.toBeNull();
    expect(await lock.tryAcquire()).toBeNull();
    let lost = false;
    void lease?.lost.then(() => {
      lost = true;
    });
    lease?.release();
    lease?.release();
    await flush();
    expect(await lock.tryAcquire()).not.toBeNull();
    expect(lost).toBe(false);
    expect(unhandled).toStrictEqual([]);
  });

  it('очередь: acquire ждёт release хозяина; снятый сигналом — AbortError, колбэк не зовётся', async () => {
    const locks = new FakeLocks();
    const lock = new WebRoundLock(locks);
    const owner = await lock.tryAcquire();
    const cancel = new AbortController();
    const dropped = lock.acquire(cancel.signal);
    const waiting = lock.acquire(new AbortController().signal);
    cancel.abort();
    await expect(dropped).rejects.toMatchObject({ name: 'AbortError' });
    owner?.release();
    const next = await waiting;
    expect(next).toBeDefined();
    expect(locks.calls).toStrictEqual([1, 3]);
    expect(unhandled).toStrictEqual([]);
  });

  it('steal: у хозяина сбывается lost, перехвативший держит замок; release хозяина после потери ничего не отпускает', async () => {
    const lock = new WebRoundLock(new FakeLocks());
    const owner = await lock.tryAcquire();
    let lost = false;
    void owner?.lost.then(() => {
      lost = true;
    });
    const thief = await lock.steal();
    await flush();
    expect(lost).toBe(true);
    owner?.release();
    await flush();
    expect(await lock.tryAcquire()).toBeNull();
    thief.release();
    await flush();
    expect(await lock.tryAcquire()).not.toBeNull();
    expect(unhandled).toStrictEqual([]);
  });
});

describe('BroadcastTabChannel и UuidKeys', () => {
  it('канал: данные сообщений — слушателю, чужие события — мимо, отписка работает', () => {
    const target = new EventTarget();
    const channel = new BroadcastTabChannel(target);
    const heard: unknown[] = [];
    const unlisten = channel.listen((message) => heard.push(message));
    target.dispatchEvent(new MessageEvent('message', { data: { revision: 1 } }));
    target.dispatchEvent(new Event('message'));
    unlisten();
    target.dispatchEvent(new MessageEvent('message', { data: { revision: 2 } }));
    expect(heard).toStrictEqual([{ revision: 1 }]);
  });

  it('ключи — из источника UUID как есть', () => {
    const values = ['550e8400-e29b-41d4-a716-446655440000', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'];
    const keys = new UuidKeys(() => values.shift() ?? '');
    expect([keys.next(), keys.next()]).toStrictEqual(['550e8400-e29b-41d4-a716-446655440000', '6ba7b810-9dad-11d1-80b4-00c04fd430c8']);
  });
});
