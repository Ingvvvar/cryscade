// Сессия вкладки (§11, решение 6 фазы 7): начало и чистый результат раундов, закрытых этой вкладкой. Живёт в
// sessionStorage — переживает перезагрузку, у новой вкладки своя. Испорчена или недоступна — новая сессия; запись,
// которая не удалась, молча остаётся в памяти. Один раунд считается один раз: ответ endRound приходит на него однажды,
// а повтор после перезагрузки отсекает id последнего посчитанного.

import { isRecord, isToken } from '../protocol/index.ts';
import type { KeyValueStore, SettledRound } from '../client/index.ts';

export interface SessionView {
  /** Начало сессии, мс от эпохи. */
  readonly startedAt: number;
  /** Σ (выигрыш − ставка) закрытых раундов, минимальные единицы; бывает отрицательным. */
  readonly netMinor: number;
}

export const SESSION_KEY = 'cryscade:session';

interface Stored extends SessionView {
  readonly last: string | null;
}

function parse(raw: string): Stored | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value['v'] !== 1) return null;
  const { startedAt, netMinor, last } = value;
  if (typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt) || startedAt < 0) return null;
  if (typeof netMinor !== 'number' || !Number.isSafeInteger(netMinor)) return null;
  if (last !== null && !isToken(last)) return null;
  return { startedAt, netMinor, last };
}

export class SessionTracker {
  readonly #store: () => KeyValueStore;
  readonly #listeners = new Set<() => void>();
  #stored: Stored;
  #view: SessionView;

  /** store — геттер sessionStorage: сам доступ бросает, когда хранилище закрыто. now — часы корня композиции. */
  constructor(store: () => KeyValueStore, now: () => number) {
    this.#store = store;
    let raw: string | null;
    try {
      raw = store().getItem(SESSION_KEY);
    } catch {
      raw = null;
    }
    const found = raw === null ? null : parse(raw);
    this.#stored = found ?? { startedAt: now(), netMinor: 0, last: null };
    this.#view = { startedAt: this.#stored.startedAt, netMinor: this.#stored.netMinor };
    if (found === null) this.#save();
  }

  getSnapshot(): SessionView {
    return this.#view;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  settle(round: Pick<SettledRound, 'roundId' | 'betMinor' | 'winMinor'>): void {
    if (round.roundId === this.#stored.last) return;
    const netMinor = this.#stored.netMinor + round.winMinor - round.betMinor;
    if (!Number.isSafeInteger(netMinor)) return;
    this.#stored = { startedAt: this.#stored.startedAt, netMinor, last: round.roundId };
    this.#view = { startedAt: this.#stored.startedAt, netMinor };
    this.#save();
    for (const listener of [...this.#listeners]) listener();
  }

  #save(): void {
    try {
      this.#store().setItem(SESSION_KEY, JSON.stringify({ v: 1, ...this.#stored }));
    } catch {
      // Хранилище недоступно: сессия живёт до перезагрузки.
    }
  }
}
