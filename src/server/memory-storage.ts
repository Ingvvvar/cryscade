import { compareKeys, keyId, toKey } from './key-order.ts';
import type { CommitBatch, CommitOutcome, IndexedRecord, IndexName, KeyRange, Storage, StoreKey, StoreName, WriteOp } from './ports.ts';
import { migrate, WALLET_ID, type StoreOptions, type UpgradeTarget } from './schema.ts';

// Хранилище в памяти — прод-код: режим «IndexedDB недоступна» и опора всех тестов сервера. Держит ту же семантику,
// что IndexedDB: схема — из тех же миграций; commit — одна транзакция «всё или ничего» с условием по кошельку;
// add не перезаписывает; уникальный индекс не пускает дубль; ключи — все типы IndexedDB в её порядке (key-order.ts),
// не-ключ в индекс не попадает; записи копируются структурно на входе и на выходе, так что снаружи их не изменить.

/** Нарушение ограничения хранилища — как ConstraintError и DataError в IndexedDB: транзакция откатывается. */
export class StorageError extends Error {
  override readonly name = 'StorageError';
}

/** Ключ, переданный хранилищу, — как DataError в IndexedDB: не ключ — ошибка. */
function keyOf(value: StoreKey, what: string): StoreKey {
  const key = toKey(value);
  if (key === null) throw new StorageError(`${what}: не ключ IndexedDB`);
  return key;
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

/** Запись под своим ключом; карта хранилища — по тождеству ключа (keyId), а не по ссылке. */
interface Entry {
  readonly key: StoreKey;
  readonly value: unknown;
}

/** Запись индекса: ключ записи, значение индекса и сама запись — ещё не скопированная. */
interface IndexEntry {
  readonly key: StoreKey;
  readonly indexKey: StoreKey;
  readonly value: unknown;
}

class MemoryStore {
  readonly #name: StoreName;
  readonly #options: StoreOptions;
  readonly #indexes: Map<IndexName, IndexDef>;
  readonly #records: Map<string, Entry>;
  #nextKey: number;

  constructor(name: StoreName, options: StoreOptions, indexes = new Map<IndexName, IndexDef>(), records = new Map<string, Entry>(), nextKey = 1) {
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
    return structuredClone(this.#records.get(keyId(keyOf(key, `${this.#name}: get`)))?.value);
  }

  write(value: object, overwrite: boolean): void {
    const keyPath = this.#options.keyPath;
    const key = keyPath === null ? this.#nextKey : toKey(field(value, keyPath));
    if (key === null) throw new StorageError(`${this.#name}: у записи нет ключа ${keyPath ?? ''}`);
    const id = keyId(key);
    if (!overwrite && this.#records.has(id)) throw new StorageError(`${this.#name}: запись ${keyId(key)} уже есть`);
    for (const [index, { keyPath: path, unique }] of this.#indexes) {
      const indexKey = toKey(field(value, path));
      if (!unique || indexKey === null) continue;
      for (const [otherId, other] of this.#records) {
        const taken = toKey(field(other.value, path));
        if (otherId !== id && taken !== null && compareKeys(taken, indexKey) === 0) {
          throw new StorageError(`${this.#name}: индекс ${index} уже занят значением ${keyId(indexKey)}`);
        }
      }
    }
    this.#records.set(id, { key, value: structuredClone(value) });
    if (keyPath === null) this.#nextKey += 1;
  }

  delete(key: StoreKey): void {
    this.#records.delete(keyId(keyOf(key, `${this.#name}: delete`)));
  }

  /** Записи индекса по возрастанию значения индекса, при равенстве — ключа; не-ключ в индекс не попадает. */
  #indexed(index: IndexName): IndexEntry[] {
    const def = this.#indexes.get(index);
    if (def === undefined) throw new StorageError(`${this.#name}: нет индекса ${index}`);
    const entries: IndexEntry[] = [];
    for (const { key, value } of this.#records.values()) {
      const indexKey = toKey(field(value, def.keyPath));
      if (indexKey !== null) entries.push({ key, indexKey, value });
    }
    return entries.sort((a, b) => compareKeys(a.indexKey, b.indexKey) || compareKeys(a.key, b.key));
  }

  /**
   * Записи со значением индекса в диапазоне, по возрастанию. Значения и ключи — копии. Нижняя граница выше верхней —
   * ошибка, как DataError у IDBKeyRange.bound: в IndexedDB такой запрос не дойдёт до хранилища.
   */
  byIndex(index: IndexName, range: KeyRange): IndexedRecord[] {
    const bounds = { lower: keyOf(range.lower, 'нижняя граница'), upper: keyOf(range.upper, 'верхняя граница') };
    if (compareKeys(bounds.lower, bounds.upper) > 0) throw new StorageError(`${this.#name}: нижняя граница диапазона выше верхней`);
    return this.#indexed(index)
      .filter((entry) => inRange(entry.indexKey, bounds))
      .map(copied);
  }

  /** Индекс сверху вниз до первой записи, где stop — да, включительно: как курсор prev в IndexedDB. */
  descend(index: IndexName, stop: (indexKey: StoreKey) => boolean): IndexedRecord[] {
    const found: IndexedRecord[] = [];
    for (const entry of this.#indexed(index).reverse()) {
      const record = copied(entry);
      found.push(record);
      if (stop(record.indexKey)) break;
    }
    return found;
  }

  /** Все записи по возрастанию ключа — простые данные для снимка. */
  entries(): [StoreKey, unknown][] {
    return [...this.#records.values()]
      .sort((a, b) => compareKeys(a.key, b.key))
      .map(({ key, value }): [StoreKey, unknown] => [copyKey(key), structuredClone(value)]);
  }
}

/** Копия ключа: у дат, двоичных и массивов — новый объект, как отдаёт курсор IndexedDB. */
function copyKey(key: StoreKey): StoreKey {
  return toKey(key) ?? key;
}

function copied(entry: IndexEntry): IndexedRecord {
  return { key: copyKey(entry.key), indexKey: copyKey(entry.indexKey), value: structuredClone(entry.value) };
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

  descend(store: StoreName, index: IndexName, stop: (indexKey: StoreKey) => boolean): Promise<IndexedRecord[]> {
    return this.#run(() => this.#store(this.#stores, store).descend(index, stop));
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
    return {
      wallet: of('wallet'),
      rounds: of('rounds'),
      keys: of('keys'),
      quarantine: of('quarantine'),
      fairness: of('fairness'),
      secrets: of('secrets'),
    };
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
