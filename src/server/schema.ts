import type { IndexName, StoreName } from './ports.ts';

// Схема IndexedDB (§6.6). Миграции — данные: шаг на каждую версию, по порядку. onupgradeneeded в worker.ts прогоняет
// шаги от старой версии до текущей в одной транзакции versionchange; MemoryStorage строит свои хранилища теми же
// шагами — поэтому схема в памяти и в IndexedDB одна.

export const DB_NAME = 'cryscade';
export const DB_VERSION = 1;
/** Кошелёк один, у него постоянный ключ. */
export const WALLET_ID = 'main';

export interface StoreOptions {
  readonly keyPath: string | null;
  readonly autoIncrement: boolean;
}

/** То, над чем работает шаг миграции. Над IDBDatabase — в worker.ts, в памяти — в MemoryStorage, в тесте — подставной. */
export interface UpgradeTarget {
  createStore(store: StoreName, options: StoreOptions): void;
  createIndex(store: StoreName, index: IndexName, keyPath: string, unique: boolean): void;
}

export interface Migration {
  readonly version: number;
  readonly up: (target: UpgradeTarget) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(target) {
      target.createStore('wallet', { keyPath: 'id', autoIncrement: false });
      target.createStore('rounds', { keyPath: 'roundId', autoIncrement: false });
      // Уникальный seq — последний рубеж против двух раундов на одном месте, если подвели и замок, и CAS.
      target.createIndex('rounds', 'seq', 'seq', true);
      target.createStore('keys', { keyPath: 'key', autoIncrement: false });
      // Ключи раунда — чтобы вытеснять их вместе с раундом, не доверяя содержимому самой записи раунда.
      target.createIndex('keys', 'roundId', 'roundId', false);
      target.createStore('quarantine', { keyPath: null, autoIncrement: true });
    },
  },
];

/** Шаги после fromVersion до toVersion включительно, по порядку. Версия БД выше нашей — RangeError. */
export function migrate(target: UpgradeTarget, fromVersion: number, toVersion: number = DB_VERSION): void {
  if (!Number.isSafeInteger(fromVersion) || fromVersion < 0 || fromVersion > toVersion || toVersion > DB_VERSION) {
    throw new RangeError(`миграция: нет пути с версии ${String(fromVersion)} на ${String(toVersion)}`);
  }
  for (const migration of MIGRATIONS) {
    if (migration.version > fromVersion && migration.version <= toVersion) migration.up(target);
  }
}
