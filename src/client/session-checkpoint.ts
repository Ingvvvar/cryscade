// Контрольная точка показа в sessionStorage (§6.5): { roundId, group } одной записью. Хранилище переживает пустое,
// испорченное и недоступное состояние: чтение без записи, мусор или чужой раунд — null, отказ хранилища — молча.

import type { CheckpointStore } from './presenter.ts';

/** То, что нужно от sessionStorage. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const CHECKPOINT_KEY = 'cryscade:checkpoint';

export class SessionCheckpoint implements CheckpointStore {
  readonly #store: () => KeyValueStore;

  /** store — геттер: сам доступ к sessionStorage бросает, когда хранилище закрыто (SecurityError). */
  constructor(store: () => KeyValueStore) {
    this.#store = store;
  }

  read(roundId: string): number | null {
    let raw: string | null;
    try {
      raw = this.#store().getItem(CHECKPOINT_KEY);
    } catch {
      return null;
    }
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    const { roundId: stored, group } = value as { readonly roundId?: unknown; readonly group?: unknown };
    if (stored !== roundId || typeof group !== 'number' || !Number.isSafeInteger(group) || group < 0) return null;
    return group;
  }

  write(roundId: string, group: number): void {
    try {
      this.#store().setItem(CHECKPOINT_KEY, JSON.stringify({ roundId, group }));
    } catch {
      // Хранилище закрыто или полно: восстановление начнёт раунд сначала.
    }
  }
}
