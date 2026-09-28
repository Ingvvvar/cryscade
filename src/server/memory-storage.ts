import type { CommitBatch, CommitOutcome, IndexedRecord, IndexName, KeyRange, Storage, StoreKey, StoreName, WriteOp } from './ports.ts';
import { migrate, WALLET_ID, type StoreOptions, type UpgradeTarget } from './schema.ts';

// Хранилище в памяти — прод-код: режим «IndexedDB недоступна» и опора всех тестов сервера. Держит ту же семантику,
// что IndexedDB: схема — из тех же миграций; commit — одна транзакция «всё или ничего» с условием по кошельку;
// add не перезаписывает; уникальный индекс не пускает дубль; ключ — строка или число; записи копируются структурно
// на входе и на выходе, так что снаружи их не изменить.

/** Нарушение ограничения хранилища — как ConstraintError и DataError в IndexedDB: транзакция откатывается. */
export class StorageError extends Error {
  override readonly name = 'StorageError';
}

function isKey(value: unknown): value is StoreKey {
  return typeof value === 'string' || (typeof value === 'number' && !Number.isNaN(value));
}

/** Порядок ключей IndexedDB для наших типов: числа раньше строк, строки — по кодовым единицам. */
function compareKeys(a: StoreKey, b: StoreKey): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function inRange(key: StoreKey, range: KeyRange): boolean {
  return compareKeys(key, range.lower) >= 0 && compareKeys(key, range.upper) <= 0;
}

function field(value: unknown, keyPath: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>)[keyPath] : undefined;
}

interface IndexDef {
  readonly keyPath: string;
  readonly unique: boolean;
}

class MemoryStore {
  readonly #name: StoreName;
  readonly #options: StoreOptions;
  readonly #indexes: Map<IndexName, IndexDef>;
  readonly #records: Map<StoreKey, unknown>;
  #nextKey: number;

  constructor(name: StoreName, options: StoreOptions, indexes = new Map<IndexName, IndexDef>(), records = new Map<StoreKey, unknown>(), nextKey = 1) {
    this.#name = name;
    this.#options = options;
    this.#indexes = indexes;
    this.#records = records;
    this.#nextKey = nextKey;
  }

  /** Копия для транзакции: записи не меняются на месте, поэтому хватает копии карт. */
  fork(): MemoryStore {
    return new MemoryStore(this.#name, this.#options, new Map(this.#indexes), new Map(this.#records), this.#nextKey);
  }

  createIndex(index: IndexName, keyPath: string, unique: boolean): void {
    this.#indexes.set(index, { keyPath, unique });
  }

  get(key: StoreKey): unknown {
    return structuredClone(this.#records.get(key));
  }

  write(value: object, overwrite: boolean): void {
    const keyPath = this.#options.keyPath;
    const key: unknown = keyPath === null ? this.#nextKey : field(value, keyPath);
    if (!isKey(key)) throw new StorageError(`${this.#name}: у записи нет ключа ${keyPath ?? ''}`);
    if (!overwrite && this.#records.has(key)) throw new StorageError(`${this.#name}: запись ${String(key)} уже есть`);
    for (const [index, { keyPath: path, unique }] of this.#indexes) {
      const indexKey = field(value, path);
      if (!unique || !isKey(indexKey)) continue;
      for (const [other, stored] of this.#records) {
        if (other !== key && field(stored, path) === indexKey) {
          throw new StorageError(`${this.#name}: индекс ${index} уже занят значением ${String(indexKey)}`);
        }
      }
    }
    this.#records.set(key, structuredClone(value));
    if (keyPath === null) this.#nextKey += 1;
  }

  delete(key: StoreKey): void {
    this.#records.delete(key);
  }

  /** Записи со значением индекса в диапазоне, по возрастанию индекса, при равенстве — ключа. Значения — копии. */
  byIndex(index: IndexName, range: KeyRange): IndexedRecord[] {
    const def = this.#indexes.get(index);
    if (def === undefined) throw new StorageError(`${this.#name}: нет индекса ${index}`);
    const entries: IndexedRecord[] = [];
    for (const [key, value] of this.#records) {
      const indexKey = field(value, def.keyPath);
      if (isKey(indexKey) && inRange(indexKey, range)) entries.push({ key, indexKey, value });
    }
    return entries
      .sort((a, b) => compareKeys(a.indexKey, b.indexKey) || compareKeys(a.key, b.key))
      .map((entry) => ({ ...entry, value: structuredClone(entry.value) }));
  }

  /** Все записи по возрастанию ключа — простые данные для снимка. */
  entries(): [StoreKey, unknown][] {
    return [...this.#records]
      .sort(([a], [b]) => compareKeys(a, b))
      .map(([key, value]): [StoreKey, unknown] => [key, structuredClone(value)]);
  }
}

export type StorageSnapshot = Readonly<Record<StoreName, readonly (readonly [StoreKey, unknown])[]>>;

export interface MemoryStorageOptions {
  /** true — память стоит на месте IndexedDB (тесты). В проде память — это режим без IndexedDB: false. */
  readonly durable?: boolean;
}

export class MemoryStorage implements Storage {
  readonly durable: boolean;
  #stores = new Map<StoreName, MemoryStore>();

  constructor(options: MemoryStorageOptions = {}) {
    this.durable = options.durable ?? false;
    const stores = this.#stores;
    const target: UpgradeTarget = {
      createStore(store, storeOptions) {
        stores.set(store, new MemoryStore(store, storeOptions));
      },
      createIndex(store, index, keyPath, unique) {
        const found = stores.get(store);
        if (found === undefined) throw new StorageError(`миграция: индекс ${index} на несозданном ${store}`);
        found.createIndex(index, keyPath, unique);
      },
    };
    migrate(target, 0);
  }

  get(store: StoreName, key: StoreKey): Promise<unknown> {
    return this.#run(() => this.#store(this.#stores, store).get(key));
  }

  keysByIndex(store: StoreName, index: IndexName, range: KeyRange): Promise<StoreKey[]> {
    return this.#run(() => this.#store(this.#stores, store).byIndex(index, range).map((entry) => entry.key));
  }

  lastByIndex(store: StoreName, index: IndexName, range: KeyRange, limit: number): Promise<IndexedRecord[]> {
    return this.#run(() => this.#store(this.#stores, store).byIndex(index, range).reverse().slice(0, limit));
  }

  commit(batch: CommitBatch): Promise<CommitOutcome> {
    return this.#run(() => {
      if (!batch.precondition(this.#store(this.#stores, 'wallet').get(WALLET_ID))) return 'conflict';
      const staged = new Map([...this.#stores].map(([name, store]) => [name, store.fork()] as const));
      for (const op of batch.ops) this.#apply(staged, op);
      this.#stores = staged;
      return 'committed';
    });
  }

  /** Снимок всех хранилищ — простые данные: тесты сравнивают состояние через публичный API. */
  snapshot(): StorageSnapshot {
    const of = (store: StoreName): [StoreKey, unknown][] => this.#store(this.#stores, store).entries();
    return { wallet: of('wallet'), rounds: of('rounds'), keys: of('keys'), quarantine: of('quarantine') };
  }

  #apply(stores: ReadonlyMap<StoreName, MemoryStore>, op: WriteOp): void {
    const store = this.#store(stores, op.store);
    if (op.op === 'delete') store.delete(op.key);
    else store.write(op.value, op.op === 'put');
  }

  #store(stores: ReadonlyMap<StoreName, MemoryStore>, name: StoreName): MemoryStore {
    const store = stores.get(name);
    if (store === undefined) throw new StorageError(`нет хранилища ${name}`);
    return store;
  }

  /** Как IndexedDB: ответ — всегда промис, ошибка — отклонённый промис, а не исключение в вызывающем. */
  #run<T>(work: () => T): Promise<T> {
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new StorageError(String(error)));
    }
  }
}
