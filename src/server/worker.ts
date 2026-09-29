// Корень композиции воркера (§3, §6.4). Только здесь — IndexedDB, Web Locks, BroadcastChannel, crypto и время:
// настоящие адаптеры портов живут в этом файле, логика сервера — на портах в остальном server/. Недоступная IndexedDB
// (сбой open, VersionError — база новее нашей, SecurityError) — хранилище в памяти на сессию воркера, уведомление
// volatile, свой замок кошелька и молчание в общем канале: баланс в памяти — не баланс вкладок с IndexedDB.

import { DEFAULT_CONFIG } from '../core/model/config.ts';
import { PROTOCOL_VERSION, TAB_CHANNEL, type StorageClosed, type WalletChanged } from '../protocol/index.ts';
import {
  DB_NAME,
  DB_VERSION,
  MemoryLock,
  MemoryStorage,
  RgsServer,
  StorageError,
  WALLET_ID,
  migrate,
  type Broadcast,
  type Clock,
  type CommitBatch,
  type CommitOutcome,
  type Entropy,
  type IndexName,
  type IndexedRecord,
  type KeyRange,
  type Lock,
  type Storage,
  type StoreKey,
  type StoreName,
  type UpgradeTarget,
  type WriteOp,
} from './index.ts';

const STORES: readonly StoreName[] = ['wallet', 'rounds', 'keys', 'quarantine'];

const CLOSED: StorageClosed = { v: PROTOCOL_VERSION, type: 'storageClosed', reason: 'versionchange' };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new StorageError(String(error));
}

/** Запрос IndexedDB → промис. */
function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(asError(request.error ?? new StorageError('запрос IndexedDB не прошёл')));
    };
  });
}

function apply(transaction: IDBTransaction, op: WriteOp): void {
  const store = transaction.objectStore(op.store);
  if (op.op === 'delete') store.delete(op.key);
  else if (op.op === 'put') store.put(op.value);
  else store.add(op.value);
}

/** Миграции §6.6 над IDBDatabase: те же шаги, что строят хранилище в памяти. */
function upgradeTarget(db: IDBDatabase, transaction: IDBTransaction): UpgradeTarget {
  return {
    createStore(store, options) {
      db.createObjectStore(store, { keyPath: options.keyPath, autoIncrement: options.autoIncrement });
    },
    createIndex(store, index, keyPath, unique) {
      transaction.objectStore(store).createIndex(index, keyPath, { unique });
    },
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const transaction = request.transaction;
      if (transaction !== null) migrate(upgradeTarget(request.result, transaction), event.oldVersion, event.newVersion ?? DB_VERSION);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(asError(request.error ?? new StorageError('IndexedDB не открылась')));
    };
  });
}

/**
 * Storage на IndexedDB (§6.6). Чтение — своей readonly-транзакцией; commit — одна readwrite-транзакция на все
 * хранилища: кошелёк читается внутри неё, условие CAS решает, отменить ли её целиком. Другая вкладка открыла базу новой
 * версии (versionchange) — соединение закрывается, чтобы не держать обновление, дальше любое обращение — ошибка.
 */
class IndexedDbStorage implements Storage {
  readonly durable = true;
  readonly #db: IDBDatabase;
  #closed = false;

  constructor(db: IDBDatabase, onClosed: () => void) {
    this.#db = db;
    db.onversionchange = () => {
      this.#closed = true;
      db.close();
      onClosed();
    };
  }

  get(store: StoreName, key: StoreKey): Promise<unknown> {
    return this.#read(store, (objects) => settled<unknown>(objects.get(key)));
  }

  keysByIndex(store: StoreName, index: IndexName, range: KeyRange): Promise<StoreKey[]> {
    return this.#read(store, (objects) => settled(objects.index(index).getAllKeys(IDBKeyRange.bound(range.lower, range.upper))));
  }

  lastByIndex(store: StoreName, index: IndexName, range: KeyRange, limit: number): Promise<IndexedRecord[]> {
    if (limit < 1) return Promise.resolve([]);
    return this.#read(store, (objects) => this.#down(objects.index(index), IDBKeyRange.bound(range.lower, range.upper), (found) => found.length >= limit));
  }

  descend(store: StoreName, index: IndexName, stop: (indexKey: StoreKey) => boolean): Promise<IndexedRecord[]> {
    return this.#read(store, (objects) =>
      this.#down(objects.index(index), null, (found) => {
        const last = found.at(-1);
        return last !== undefined && stop(last.indexKey);
      }),
    );
  }

  commit(batch: CommitBatch): Promise<CommitOutcome> {
    return new Promise((resolve, reject) => {
      this.#ensureOpen();
      const transaction = this.#db.transaction(STORES, 'readwrite');
      let conflict = false;
      let failure: Error | null = null;
      transaction.oncomplete = () => {
        resolve('committed');
      };
      transaction.onabort = () => {
        if (conflict) resolve('conflict');
        else reject(failure ?? asError(transaction.error ?? new StorageError('транзакция отменена')));
      };
      const stored = transaction.objectStore('wallet').get(WALLET_ID);
      stored.onsuccess = () => {
        try {
          if (!batch.precondition(stored.result)) {
            conflict = true;
            transaction.abort();
            return;
          }
          for (const op of batch.ops) apply(transaction, op);
        } catch (error) {
          failure = asError(error);
          transaction.abort();
        }
      };
    });
  }

  #ensureOpen(): void {
    if (this.#closed) throw new StorageError('хранилище закрыто: гру оновлено в іншій вкладці');
  }

  #read<T>(store: StoreName, work: (objects: IDBObjectStore) => Promise<T>): Promise<T> {
    try {
      this.#ensureOpen();
      return work(this.#db.transaction(store, 'readonly').objectStore(store));
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  /** Курсор prev: записи индекса сверху вниз, пока done не скажет хватит. */
  #down(index: IDBIndex, range: IDBKeyRange | null, done: (found: readonly IndexedRecord[]) => boolean): Promise<IndexedRecord[]> {
    return new Promise((resolve, reject) => {
      const found: IndexedRecord[] = [];
      const request = index.openCursor(range, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) {
          resolve(found);
          return;
        }
        found.push({ key: cursor.primaryKey, indexKey: cursor.key, value: cursor.value as unknown });
        if (done(found)) resolve(found);
        else cursor.continue();
      };
      request.onerror = () => {
        reject(asError(request.error ?? new StorageError('курсор IndexedDB не прошёл')));
      };
    });
  }
}

/** Замок кошелька — Web Locks: у всех вкладок один писатель (§6.3). */
class WebLocksLock implements Lock {
  withLock<T>(name: string, task: () => Promise<T>): Promise<T> {
    return navigator.locks.request(name, { mode: 'exclusive' }, task);
  }
}

class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Криптостойкие сиды и id раундов (§4.7): crypto — забота сервера, core его не трогает. */
class CryptoEntropy implements Entropy {
  readonly #word = new Uint32Array(1);

  seed(): number {
    crypto.getRandomValues(this.#word);
    return this.#word[0] ?? 0;
  }

  roundId(): string {
    return crypto.randomUUID();
  }
}

/** Оповещения остальным вкладкам (§6.3). */
class ChannelBroadcast implements Broadcast {
  readonly #channel: BroadcastChannel;

  constructor(channel: BroadcastChannel) {
    this.#channel = channel;
  }

  walletChanged(message: WalletChanged): void {
    this.#channel.postMessage(message);
  }
}

/** Хранилище в памяти — вкладка сама по себе: её баланс не уходит вкладкам с IndexedDB. */
const SILENT: Broadcast = { walletChanged: () => undefined };

interface ServerParts {
  readonly storage: Storage;
  readonly lock: Lock;
  readonly broadcast: Broadcast;
}

async function storageParts(scope: DedicatedWorkerGlobalScope): Promise<ServerParts> {
  try {
    const db = await openDatabase();
    const storage = new IndexedDbStorage(db, () => {
      scope.postMessage(CLOSED);
    });
    return { storage, lock: new WebLocksLock(), broadcast: new ChannelBroadcast(new BroadcastChannel(TAB_CHANNEL)) };
  } catch {
    return { storage: new MemoryStorage({ durable: false }), lock: new MemoryLock(), broadcast: SILENT };
  }
}

/** Сервер собирается один раз; запросы, пришедшие раньше, ждут готовности и уходят по порядку. */
function start(scope: DedicatedWorkerGlobalScope): void {
  const ready = storageParts(scope).then(
    (parts) => new RgsServer({ ...parts, clock: new SystemClock(), entropy: new CryptoEntropy() }, { config: DEFAULT_CONFIG }),
  );
  scope.onmessage = (event: MessageEvent<unknown>) => {
    void ready
      .then((server) => server.handle(event.data))
      .then((response) => {
        scope.postMessage(response);
      });
  };
}

start(self);
