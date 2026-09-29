import type { WalletChanged } from '../protocol/index.ts';

// Порты сервера (§6.4). Логика зависит от них, а не от браузера: адаптеры в памяти — в server/, настоящие —
// IndexedDB, Web Locks, crypto, BroadcastChannel — только в worker.ts.

export type StoreName = 'wallet' | 'rounds' | 'keys' | 'quarantine';
export type IndexName = 'seq' | 'roundId';
/**
 * Ключ записи и значение индекса — любой ключ IndexedDB: число, дата, строка, двоичные данные, массив ключей.
 * Сервер пишет только строки и целые, но в испорченном хранилище лежит что угодно, и читать его надо как есть.
 */
export type StoreKey = IDBValidKey;

/** Границы включительно. */
export interface KeyRange {
  readonly lower: StoreKey;
  readonly upper: StoreKey;
}

/** Запись, найденная по индексу: первичный ключ, значение индекса и сама запись как есть. */
export interface IndexedRecord {
  readonly key: StoreKey;
  readonly indexKey: StoreKey;
  readonly value: unknown;
}

/** add не перезаписывает: запись с тем же ключом — ошибка, транзакция откатывается целиком. */
export type WriteOp =
  | { readonly op: 'put'; readonly store: StoreName; readonly value: object }
  | { readonly op: 'add'; readonly store: StoreName; readonly value: object }
  | { readonly op: 'delete'; readonly store: StoreName; readonly key: StoreKey };

export interface CommitBatch {
  /**
   * CAS: адаптер читает кошелёк внутри той же транзакции и спрашивает условие. false — транзакция отменяется,
   * ничего не записано, ответ conflict. Так защита держится, даже если замок подвёл.
   */
  readonly precondition: (storedWallet: unknown) => boolean;
  readonly ops: readonly WriteOp[];
}

export type CommitOutcome = 'committed' | 'conflict';

export interface Storage {
  /** Переживает ли хранилище перезагрузку: IndexedDB — да, память — нет. */
  readonly durable: boolean;
  /** Запись как есть — её проверяет гард репозитория. Нет записи — undefined. */
  get(store: StoreName, key: StoreKey): Promise<unknown>;
  /** Первичные ключи записей со значением индекса в диапазоне, по возрастанию индекса. */
  keysByIndex(store: StoreName, index: IndexName, range: KeyRange): Promise<StoreKey[]>;
  /** Записи с наибольшими значениями индекса в диапазоне, по убыванию, не больше limit. */
  lastByIndex(store: StoreName, index: IndexName, range: KeyRange, limit: number): Promise<IndexedRecord[]>;
  /**
   * Индекс сверху вниз по всем ключам, без границ, до первой записи, на которой stop ответит да, включительно; одно
   * чтение. Порядок — IndexedDB: массивы, двоичные, строки и даты стоят выше любого числа. Запись, чьё значение
   * индекса не ключ (NaN, объект, boolean), индексу не видна.
   */
  descend(store: StoreName, index: IndexName, stop: (indexKey: StoreKey) => boolean): Promise<IndexedRecord[]>;
  /** Одна транзакция readwrite на все хранилища: условие, затем операции по порядку — всё или ничего. */
  commit(batch: CommitBatch): Promise<CommitOutcome>;
}

export interface Lock {
  /** Эксклюзивно по имени: task не пересекается ни с одной другой задачей того же замка, очередь — по приходу. */
  withLock<T>(name: string, task: () => Promise<T>): Promise<T>;
}

export interface Clock {
  /** Миллисекунды с эпохи Unix. */
  now(): number;
}

export interface Entropy {
  /** Криптостойкое целое от 0 до 2³² − 1 — сид раунда. */
  seed(): number;
  /** Новый id раунда: уникальный, из знаков [0-9A-Za-z_-], не длиннее 64. */
  roundId(): string;
}

export interface Broadcast {
  /** Остальным вкладкам. Сбой доставки деньги не трогает: запись уже сделана. */
  walletChanged(message: WalletChanged): void;
}
