import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RgsClient, TimeoutSleep, type CallOutcome, type Transport } from '../../../src/client/index.ts';
import type { RequestBody } from '../../../src/protocol/index.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';

// RgsClient (§6.5) на поддельных таймерах: конверт и id, повторы 250/500/1000/2000 после таймаута попытки 3 с,
// окончательность ответа сервера, гард ответа, ответ на брошенную попытку, отмена.

interface Sent {
  readonly v: number;
  readonly id: number;
  readonly body: RequestBody;
}

/** Транспорт теста: запоминает отправленное и время, отвечает по команде теста. */
class ScriptedTransport implements Transport {
  readonly sent: Sent[] = [];
  readonly sentAt: number[] = [];
  broken = false;
  readonly #listeners = new Set<(message: unknown) => void>();
  readonly #start = Date.now();

  send(message: unknown): void {
    if (this.broken) throw new Error('канал закрыт');
    this.sent.push(message as Sent);
    this.sentAt.push(Date.now() - this.#start);
  }

  listen(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get listeners(): number {
    return this.#listeners.size;
  }

  reply(message: unknown): void {
    for (const listener of [...this.#listeners]) listener(message);
  }

  /** Успешный ответ на отправленную попытку номер index. */
  answer(index: number, result: unknown): void {
    this.reply({ v: 1, id: this.sent[index]?.id, body: { ok: true, result } });
  }
}

const SMALL = fixtureRound('small-win');
const WALLET = { balanceMinor: 99_900, revision: 1, notice: null };
const ENDED = { balanceMinor: 99_935, wallet: { balanceMinor: 99_935, revision: 2, notice: null } };
const PLAYED = {
  round: { roundId: 'r1', betMinor: 100, payX100: 35, winMinor: 35, events: SMALL.events },
  balanceMinor: 99_900,
  wallet: WALLET,
};
const PLAY = { type: 'play', betMinor: 100, idempotencyKey: 'k1' } as const;
const END = { type: 'endRound', roundId: 'r1' } as const;

/** Исход вызова, как только он есть; пока нет — 'pending'. */
function track<T>(promise: Promise<CallOutcome<T>>): { readonly outcome: CallOutcome<T> | 'pending' } {
  const box: { outcome: CallOutcome<T> | 'pending' } = { outcome: 'pending' };
  void promise.then((outcome) => {
    box.outcome = outcome;
  });
  return box;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('конверт и ответ', () => {
  it('запрос уходит в конверте v1 с id; ответ с тем же id — результат', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    const call = track(client.call(END));
    expect(transport.sent).toStrictEqual([{ v: 1, id: 1, body: END }]);
    expect(client.pendingAttempts).toBe(1);
    transport.answer(0, ENDED);
    await vi.advanceTimersByTimeAsync(0);
    expect(call.outcome).toStrictEqual({ kind: 'ok', result: ENDED });
    expect(client.pendingAttempts).toBe(0);
    // Ответ снял таймер попытки: ни одного висящего таймера.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('id растёт от вызова к вызову', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    void client.call(END);
    void client.call({ type: 'authenticate' });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.sent.map((message) => message.id)).toStrictEqual([1, 2]);
  });

  it('ошибка сервера — окончательный ответ, не повторяется', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    const call = track(client.call(PLAY));
    transport.reply({ v: 1, id: 1, body: { ok: false, error: { code: 'INTERNAL', message: 'квота исчерпана' } } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(call.outcome).toStrictEqual({ kind: 'rejected', error: { code: 'INTERNAL', message: 'квота исчерпана' } });
    expect(transport.sent).toHaveLength(1);
  });

  it('ответ не прошёл гард — unusable invalid с причиной, без повтора', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    const call = track(client.call(PLAY));
    transport.answer(0, { ...PLAYED, round: { ...PLAYED.round, events: SMALL.events.slice(1) } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(call.outcome).toStrictEqual({ kind: 'unusable', reason: 'invalid', detail: 'play: раунд: событие 0: win не после сетки' });
    expect(transport.sent).toHaveLength(1);
  });

  it('сервер другой версии — unusable version', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    const call = track(client.call(END));
    transport.reply({ v: 2, id: 1, body: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(call.outcome).toStrictEqual({ kind: 'unusable', reason: 'version', detail: 'сервер протокола v2' });
  });
});

describe('повторы', () => {
  it('таймаут 3 с, паузы 250, 500, 1000, 2000; тело то же, id новый; после пятой попытки — unreachable', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    const call = track(client.call(PLAY));
    await vi.advanceTimersByTimeAsync(18_749);
    expect(call.outcome).toBe('pending');
    // Попытка n уходит через 3000 · (n − 1) + сумма первых n − 1 пауз.
    expect(transport.sentAt).toStrictEqual([0, 3250, 6750, 10_750, 15_750]);
    expect(transport.sent.map((message) => message.id)).toStrictEqual([1, 2, 3, 4, 5]);
    expect(transport.sent.map((message) => message.body)).toStrictEqual([PLAY, PLAY, PLAY, PLAY, PLAY]);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.outcome).toStrictEqual({ kind: 'unreachable' });
    expect(transport.sent).toHaveLength(5);
  });

  it('ответ на брошенную попытку опоздал — игнорируется, принимается ответ текущей', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    const call = track(client.call(PLAY));
    await vi.advanceTimersByTimeAsync(3250);
    expect(transport.sent).toHaveLength(2);
    transport.answer(0, { ...PLAYED, balanceMinor: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(call.outcome).toBe('pending');
    transport.answer(1, PLAYED);
    await vi.advanceTimersByTimeAsync(0);
    expect(call.outcome).toStrictEqual({ kind: 'ok', result: PLAYED });
  });

  it('ответ без id, с чужим id и мусор — не на нашу попытку', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    const call = track(client.call(END));
    transport.reply('мусор');
    transport.reply({ v: 1, id: null, body: { ok: false, error: { code: 'BAD_REQUEST', message: 'конверт — не объект' } } });
    transport.reply({ v: 1, id: 7, body: { ok: true, result: ENDED } });
    await vi.advanceTimersByTimeAsync(0);
    expect(call.outcome).toBe('pending');
    transport.answer(0, ENDED);
    await vi.advanceTimersByTimeAsync(0);
    expect(call.outcome).toStrictEqual({ kind: 'ok', result: ENDED });
  });

  it('канал отказал на отправке — попытка потеряна сразу, без таймаута', async () => {
    const transport = new ScriptedTransport();
    transport.broken = true;
    const client = new RgsClient(transport, new TimeoutSleep());
    const call = track(client.call(END));
    transport.broken = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.sentAt).toStrictEqual([250]);
    transport.answer(0, ENDED);
    await vi.advanceTimersByTimeAsync(0);
    expect(call.outcome).toStrictEqual({ kind: 'ok', result: ENDED });
  });

  it('свои таймаут и паузы', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep(), { attemptTimeoutMs: 100, retryDelaysMs: [10] });
    const call = track(client.call(END));
    await vi.advanceTimersByTimeAsync(209);
    expect([transport.sentAt, call.outcome]).toStrictEqual([[0, 110], 'pending']);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.outcome).toStrictEqual({ kind: 'unreachable' });
  });
});

describe('отмена', () => {
  it('сигнал во время попытки — abandoned сразу, новых попыток нет', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    const stop = new AbortController();
    const call = track(client.call(PLAY, stop.signal));
    await vi.advanceTimersByTimeAsync(1000);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(call.outcome).toStrictEqual({ kind: 'abandoned' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('сигнал во время паузы — abandoned, повтор не уходит', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    const stop = new AbortController();
    const call = track(client.call(PLAY, stop.signal));
    await vi.advanceTimersByTimeAsync(3100);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(call.outcome).toStrictEqual({ kind: 'abandoned' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.sent).toHaveLength(1);
  });

  it('уже отменённый сигнал — ничего не уходит', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    const stop = new AbortController();
    stop.abort();
    expect(await client.call(PLAY, stop.signal)).toStrictEqual({ kind: 'abandoned' });
    expect(transport.sent).toStrictEqual([]);
  });

  it('dispose: отписка от транспорта, вызов в пути — abandoned, повторы не уходят', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    const call = track(client.call(PLAY));
    expect(transport.listeners).toBe(1);
    client.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect([transport.listeners, call.outcome]).toStrictEqual([0, { kind: 'abandoned' }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.sent).toHaveLength(1);
    expect(await client.call(END)).toStrictEqual({ kind: 'abandoned' });
  });
});

describe('ожидающие попытки', () => {
  it('таймаут снимает попытку: в паузе перед повтором ждущих нет, после последней — тоже', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    const call = track(client.call(PLAY));
    expect(client.pendingAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(client.pendingAttempts).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(client.pendingAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(15_500);
    expect([call.outcome, client.pendingAttempts]).toStrictEqual([{ kind: 'unreachable' }, 0]);
  });

  it('отмена, отказ канала и dispose снимают попытку сразу', async () => {
    const transport = new ScriptedTransport();
    const client = new RgsClient(transport, new TimeoutSleep());
    const stop = new AbortController();
    void client.call(PLAY, stop.signal);
    expect(client.pendingAttempts).toBe(1);
    stop.abort();
    expect(client.pendingAttempts).toBe(0);

    transport.broken = true;
    void client.call(END);
    expect(client.pendingAttempts).toBe(0);
    transport.broken = false;

    await vi.advanceTimersByTimeAsync(250);
    expect(client.pendingAttempts).toBe(1);
    client.dispose();
    expect(client.pendingAttempts).toBe(0);
  });
});
