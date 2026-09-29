import {
  isNat,
  isRecord,
  parseResponse,
  requestEnvelope,
  type ProtocolError,
  type RequestBody,
  type RequestType,
  type Results,
} from '../protocol/index.ts';
import type { Sleep, Transport } from './ports.ts';

/** Таймаут одной попытки (§6.5). */
export const ATTEMPT_TIMEOUT_MS = 3000;
/** Паузы перед повторами (§6.5): после четвёртого повтора — экран ошибки. */
export const RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000];

export type CallOutcome<T> =
  | { readonly kind: 'ok'; readonly result: T }
  /** Сервер ответил ошибкой: она не повторяется. */
  | { readonly kind: 'rejected'; readonly error: ProtocolError }
  /** Все попытки потеряны. */
  | { readonly kind: 'unreachable' }
  /** Ответ пришёл, но не годится: сервер другой версии или ответ не прошёл гард. */
  | { readonly kind: 'unusable'; readonly reason: 'version' | 'invalid'; readonly detail: string }
  /** Вызывающий отменил вызов сигналом. */
  | { readonly kind: 'abandoned' };

/** Сервер для контроллера: запрос → исход, без транспорта и повторов. */
export interface Rgs {
  call<B extends RequestBody>(body: B, signal?: AbortSignal): Promise<CallOutcome<Results[B['type']]>>;
}

export interface RgsClientOptions {
  readonly attemptTimeoutMs?: number;
  readonly retryDelaysMs?: readonly number[];
}

type Attempt = { readonly kind: 'answer'; readonly raw: unknown } | { readonly kind: 'lost' } | { readonly kind: 'aborted' };

const LOST: Attempt = { kind: 'lost' };
const ABORTED: Attempt = { kind: 'aborted' };

/**
 * Клиент RGS (§6.5): не знает транспорта. Запрос уходит в конверте с новым id на каждую попытку и тем же телом —
 * повтор play несёт тот же ключ идемпотентности. Ответ принимается только с id текущей попытки: ответ на брошенную
 * попытку опоздал и игнорируется. Повторяются только сбои транспорта — таймаут попытки и отказ канала; ответ сервера,
 * даже ошибка, — окончательный. Каждый ответ проходит гард протокола вместе с событиями раунда.
 */
export class RgsClient implements Rgs {
  readonly #transport: Transport;
  readonly #sleep: Sleep;
  readonly #timeoutMs: number;
  readonly #delays: readonly number[];
  /** Попытки в пути: id конверта → приём ответа. */
  readonly #waiting = new Map<number, (raw: unknown) => void>();
  readonly #unlisten: () => void;
  /** dispose: попытки в пути обрываются, новые не начинаются. */
  readonly #closed = new AbortController();
  #lastId = 0;

  constructor(transport: Transport, sleep: Sleep, options: RgsClientOptions = {}) {
    this.#transport = transport;
    this.#sleep = sleep;
    this.#timeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
    this.#delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.#unlisten = transport.listen((message) => {
      this.#receive(message);
    });
  }

  async call<B extends RequestBody>(body: B, signal?: AbortSignal): Promise<CallOutcome<Results[B['type']]>> {
    for (let attempt = 0; ; attempt++) {
      const answer = await this.#attempt(body, signal);
      if (answer.kind === 'answer') return this.#read<B['type']>(body.type, answer.raw);
      if (answer.kind === 'aborted') return { kind: 'abandoned' };
      const delay = this.#delays[attempt];
      if (delay === undefined) return { kind: 'unreachable' };
      if ((await this.#sleep.sleep(delay, signal)) === 'aborted') return { kind: 'abandoned' };
    }
  }

  /** Отписаться от транспорта; вызовы в пути заканчиваются исходом abandoned и больше ничего не шлют. */
  dispose(): void {
    this.#unlisten();
    this.#closed.abort();
  }

  #attempt(body: RequestBody, signal: AbortSignal | undefined): Promise<Attempt> {
    if (signal?.aborted === true || this.#closed.signal.aborted) return Promise.resolve(ABORTED);
    this.#lastId += 1;
    const id = this.#lastId;
    return new Promise((resolve) => {
      const timer = new AbortController();
      let settled = false;
      const settle = (attempt: Attempt): void => {
        if (settled) return;
        settled = true;
        this.#waiting.delete(id);
        timer.abort();
        signal?.removeEventListener('abort', onAbort);
        this.#closed.signal.removeEventListener('abort', onAbort);
        resolve(attempt);
      };
      const onAbort = (): void => {
        settle(ABORTED);
      };
      this.#waiting.set(id, (raw) => {
        settle({ kind: 'answer', raw });
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#closed.signal.addEventListener('abort', onAbort, { once: true });
      void this.#sleep.sleep(this.#timeoutMs, timer.signal).then((outcome) => {
        if (outcome === 'elapsed') settle(LOST);
      });
      try {
        this.#transport.send(requestEnvelope(id, body));
      } catch {
        settle(LOST);
      }
    });
  }

  /** Ответ без читаемого id или с чужим id — не на нашу попытку. */
  #receive(message: unknown): void {
    if (!isRecord(message)) return;
    const id = message['id'];
    if (isNat(id)) this.#waiting.get(id)?.(message);
  }

  #read<T extends RequestType>(type: T, raw: unknown): CallOutcome<Results[T]> {
    const parsed = parseResponse(type, raw);
    switch (parsed.kind) {
      case 'result':
        return { kind: 'ok', result: parsed.result };
      case 'error':
        return { kind: 'rejected', error: parsed.error };
      case 'version':
        return { kind: 'unusable', reason: 'version', detail: `сервер протокола v${String(parsed.v)}` };
      case 'invalid':
        return { kind: 'unusable', reason: 'invalid', detail: parsed.problem };
    }
  }
}
