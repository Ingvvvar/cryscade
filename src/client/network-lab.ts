import { isNat, isRecord } from '../protocol/index.ts';
import type { Sleep, Transport } from './ports.ts';

export interface LabSettings {
  /** Задержка запроса на пути к серверу, мс. Задержка длиннее таймаута попытки — это таймаут. */
  readonly latencyMs: number;
  /** Разброс сверх задержки: равномерно от 0 до jitterMs включительно. Запросы могут прийти не по порядку. */
  readonly jitterMs: number;
  /** Доля запросов, потерянных на пути к серверу, от 0 до 1. */
  readonly requestLoss: number;
  /** Доля ответов, потерянных на пути назад, от 0 до 1: сервер запрос выполнил, клиент об этом не узнал. */
  readonly responseLoss: number;
}

export const CLEAR_NETWORK: LabSettings = { latencyMs: 0, jitterMs: 0, requestLoss: 0, responseLoss: 0 };

export interface NetworkLabOptions {
  /** Случайность — снаружи: в браузере Math.random, в тестах — сценарий. От 0 включительно до 1. */
  readonly random: () => number;
  /** «Перезагрузить страницу»: в браузере — location.reload. */
  readonly reload: () => void;
}

function requestType(message: unknown): unknown {
  return isRecord(message) && isRecord(message['body']) ? message['body']['type'] : undefined;
}

function idOf(message: unknown): number | null {
  if (!isRecord(message)) return null;
  const id = message['id'];
  return isNat(id) ? id : null;
}

function checkSettings(settings: LabSettings): void {
  const { latencyMs, jitterMs, requestLoss, responseLoss } = settings;
  if (!(Number.isFinite(latencyMs) && latencyMs >= 0 && Number.isFinite(jitterMs) && jitterMs >= 0)) {
    throw new RangeError('лаборатория сети: задержка и разброс — неотрицательные числа');
  }
  if (!(requestLoss >= 0 && requestLoss <= 1 && responseLoss >= 0 && responseLoss <= 1)) {
    throw new RangeError('лаборатория сети: доля потерь — от 0 до 1');
  }
}

/**
 * «Лаборатория сети» (§6.5) — декоратор транспорта, всегда в цепочке, по умолчанию прозрачен. Настройки — задержка,
 * разброс, потеря запроса и ответа. Разовые действия: потерять следующий ответ; задержать следующий endRound до
 * releaseHeld; перезагрузить страницу, как только придёт ответ на следующий play, — посреди раунда. После этого
 * страница уходит: лаборатория ничего больше не пропускает, и endRound не успевает до сервера.
 */
export class NetworkLabTransport implements Transport {
  readonly #inner: Transport;
  readonly #sleep: Sleep;
  readonly #random: () => number;
  readonly #reload: () => void;
  readonly #listeners = new Set<(message: unknown) => void>();
  readonly #held: unknown[] = [];
  #settings: LabSettings = CLEAR_NETWORK;
  #loseNextResponse = false;
  #holdNextEndRound = false;
  /** id запросов play, ответ на любой из которых перезагрузит страницу; null — не взведено. */
  #reloadAfter: Set<number> | null = null;
  #frozen = false;

  constructor(inner: Transport, sleep: Sleep, options: NetworkLabOptions) {
    this.#inner = inner;
    this.#sleep = sleep;
    this.#random = options.random;
    this.#reload = options.reload;
    inner.listen((message) => {
      this.#fromServer(message);
    });
  }

  get settings(): LabSettings {
    return this.#settings;
  }

  set(settings: Partial<LabSettings>): void {
    const next = { ...this.#settings, ...settings };
    checkSettings(next);
    this.#settings = next;
  }

  loseNextResponse(): void {
    this.#loseNextResponse = true;
  }

  holdNextEndRound(): void {
    this.#holdNextEndRound = true;
  }

  /** Отпустить задержанные endRound — дальше по обычным правилам. */
  releaseHeld(): void {
    for (const message of this.#held.splice(0)) this.#forward(message);
  }

  reloadMidNextRound(): void {
    this.#reloadAfter = new Set();
  }

  send(message: unknown): void {
    if (this.#frozen) return;
    const type = requestType(message);
    if (type === 'endRound' && this.#holdNextEndRound) {
      this.#holdNextEndRound = false;
      this.#held.push(message);
      return;
    }
    const id = idOf(message);
    if (type === 'play' && id !== null) this.#reloadAfter?.add(id);
    this.#forward(message);
  }

  listen(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #forward(message: unknown): void {
    if (this.#frozen || this.#lost(this.#settings.requestLoss)) return;
    const { latencyMs, jitterMs } = this.#settings;
    const delay = latencyMs + (jitterMs > 0 ? Math.floor(this.#random() * (jitterMs + 1)) : 0);
    if (delay === 0) {
      this.#inner.send(message);
      return;
    }
    void this.#sleep.sleep(delay).then(() => {
      if (this.#frozen) return;
      try {
        this.#inner.send(message);
      } catch {
        // Канал закрылся, пока запрос был в пути: для клиента это потеря — его попытка истечёт по таймауту.
      }
    });
  }

  #fromServer(message: unknown): void {
    if (this.#frozen) return;
    if (this.#loseNextResponse) {
      this.#loseNextResponse = false;
      return;
    }
    if (this.#lost(this.#settings.responseLoss)) return;
    for (const listener of [...this.#listeners]) listener(message);
    const id = idOf(message);
    if (id !== null && this.#reloadAfter?.has(id) === true) {
      this.#reloadAfter = null;
      this.#frozen = true;
      this.#reload();
    }
  }

  #lost(rate: number): boolean {
    return rate > 0 && this.#random() < rate;
  }
}
