import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLEAR_NETWORK, NetworkLabTransport, TimeoutSleep, type Transport } from '../../../src/client/index.ts';

// «Лаборатория сети» (§6.5) на поддельных таймерах. Случайность — сценарий: кончилась — тест падает, так видно,
// что лишних бросков нет.

class Inner implements Transport {
  readonly sent: unknown[] = [];
  readonly sentAt: number[] = [];
  readonly #listeners = new Set<(message: unknown) => void>();
  readonly #start = Date.now();

  send(message: unknown): void {
    this.sent.push(message);
    this.sentAt.push(Date.now() - this.#start);
  }

  listen(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  reply(message: unknown): void {
    for (const listener of [...this.#listeners]) listener(message);
  }
}

function scripted(values: readonly number[]): () => number {
  const left = [...values];
  return () => {
    const value = left.shift();
    if (value === undefined) throw new Error('лишний бросок случайности');
    return value;
  };
}

const request = (id: number, type: string): unknown => ({ v: 1, id, body: { type } });
const response = (id: number): unknown => ({ v: 1, id, body: { ok: true, result: {} } });

function rig(random: readonly number[] = []): { inner: Inner; lab: NetworkLabTransport; got: unknown[]; reloads: () => number } {
  const inner = new Inner();
  let reloads = 0;
  const lab = new NetworkLabTransport(inner, new TimeoutSleep(), {
    random: scripted(random),
    reload: () => {
      reloads += 1;
    },
  });
  const got: unknown[] = [];
  lab.listen((message) => got.push(message));
  return { inner, lab, got, reloads: () => reloads };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('по умолчанию прозрачна', () => {
  it('запрос уходит сразу, ответ приходит сразу, случайность не трогается', () => {
    const { inner, lab, got } = rig();
    expect(lab.settings).toStrictEqual(CLEAR_NETWORK);
    lab.send(request(1, 'play'));
    expect(inner.sent).toStrictEqual([request(1, 'play')]);
    inner.reply(response(1));
    expect(got).toStrictEqual([response(1)]);
  });

  it('отписка — ответы больше не приходят', () => {
    const { inner, lab } = rig();
    const got: unknown[] = [];
    const off = lab.listen((message) => got.push(message));
    off();
    inner.reply(response(1));
    expect(got).toStrictEqual([]);
  });
});

describe('настройки', () => {
  it('задержка и разброс: latency + floor(r · (jitter + 1))', async () => {
    const { inner, lab } = rig([0.5]);
    lab.set({ latencyMs: 100, jitterMs: 50 });
    lab.send(request(1, 'play'));
    await vi.advanceTimersByTimeAsync(124);
    expect(inner.sent).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(inner.sentAt).toStrictEqual([125]);
  });

  it('разброс переставляет запросы', async () => {
    const { inner, lab } = rig([0.99, 0]);
    lab.set({ latencyMs: 100, jitterMs: 50 });
    lab.send(request(1, 'play'));
    lab.send(request(2, 'endRound'));
    await vi.advanceTimersByTimeAsync(200);
    expect([inner.sent, inner.sentAt]).toStrictEqual([[request(2, 'endRound'), request(1, 'play')], [100, 150]]);
  });

  it('потеря запроса и ответа — бросок меньше доли', () => {
    const { inner, lab, got } = rig([0.29, 0.3, 0.49, 0.5]);
    lab.set({ requestLoss: 0.3, responseLoss: 0.5 });
    lab.send(request(1, 'play'));
    lab.send(request(2, 'play'));
    expect(inner.sent).toStrictEqual([request(2, 'play')]);
    inner.reply(response(7));
    inner.reply(response(8));
    expect(got).toStrictEqual([response(8)]);
  });

  it.each([
    [{ latencyMs: -1 }, 'лаборатория сети: задержка и разброс — неотрицательные числа'],
    [{ jitterMs: Number.NaN }, 'лаборатория сети: задержка и разброс — неотрицательные числа'],
    [{ latencyMs: Number.POSITIVE_INFINITY }, 'лаборатория сети: задержка и разброс — неотрицательные числа'],
    [{ requestLoss: 1.01 }, 'лаборатория сети: доля потерь — от 0 до 1'],
    [{ responseLoss: -0.1 }, 'лаборатория сети: доля потерь — от 0 до 1'],
    [{ responseLoss: Number.NaN }, 'лаборатория сети: доля потерь — от 0 до 1'],
  ])('%j — RangeError, настройки прежние', (settings, message) => {
    const { lab } = rig();
    expect(() => {
      lab.set(settings);
    }).toThrow(new RangeError(message));
    expect(lab.settings).toStrictEqual(CLEAR_NETWORK);
  });
});

describe('разовые действия', () => {
  it('потерять следующий ответ — ровно один', () => {
    const { inner, lab, got } = rig();
    lab.loseNextResponse();
    inner.reply(response(1));
    inner.reply(response(2));
    expect(got).toStrictEqual([response(2)]);
  });

  it('сообщение воркера без id ответом не считается: оно доходит, а потеряется следующий ответ', () => {
    const { inner, lab, got } = rig();
    const closed = { v: 1, type: 'storageClosed', reason: 'versionchange' };
    lab.loseNextResponse();
    inner.reply(closed);
    inner.reply(response(1));
    inner.reply(response(2));
    expect(got).toStrictEqual([closed, response(2)]);
  });

  it('задержать следующий endRound: остальное идёт, endRound — после releaseHeld; следующий endRound не держится', () => {
    const { inner, lab } = rig();
    lab.holdNextEndRound();
    lab.send(request(1, 'play'));
    lab.send(request(2, 'endRound'));
    lab.send(request(3, 'authenticate'));
    expect(inner.sent).toStrictEqual([request(1, 'play'), request(3, 'authenticate')]);
    lab.releaseHeld();
    lab.send(request(4, 'endRound'));
    expect(inner.sent).toStrictEqual([request(1, 'play'), request(3, 'authenticate'), request(2, 'endRound'), request(4, 'endRound')]);
  });

  it('повторы задержанного endRound держатся с ним до releaseHeld: попытка клиента по таймауту задержку не обходит', () => {
    const { inner, lab } = rig();
    lab.holdNextEndRound();
    lab.send(request(2, 'endRound'));
    lab.send(request(3, 'endRound'));
    lab.send(request(4, 'endRound'));
    expect(inner.sent).toStrictEqual([]);
    lab.releaseHeld();
    expect(inner.sent).toStrictEqual([request(2, 'endRound'), request(3, 'endRound'), request(4, 'endRound')]);
    lab.send(request(5, 'endRound'));
    expect(inner.sent).toStrictEqual([request(2, 'endRound'), request(3, 'endRound'), request(4, 'endRound'), request(5, 'endRound')]);
  });

  it('перезагрузка посреди раунда: ответ на play доставлен, страница перезагружается, дальше — ничего', () => {
    const { inner, lab, got, reloads } = rig();
    lab.reloadMidNextRound();
    lab.send(request(4, 'authenticate'));
    inner.reply(response(4));
    expect(reloads()).toBe(0);
    // Первая попытка play потерялась — перезагрузку взводит любая из его попыток.
    lab.send(request(5, 'play'));
    lab.send(request(6, 'play'));
    inner.reply(response(6));
    expect([got, reloads()]).toStrictEqual([[response(4), response(6)], 1]);
    lab.send(request(7, 'endRound'));
    inner.reply(response(5));
    expect([inner.sent.length, got.length, reloads()]).toStrictEqual([3, 2, 1]);
  });
});
