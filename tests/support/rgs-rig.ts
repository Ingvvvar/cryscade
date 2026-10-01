import { NodeCrypto, ScriptedBytes } from './node-crypto.ts';
import { DEFAULT_CONFIG, type GameConfig } from '../../src/core/model/config.ts';
import type { ResponseBody, WalletChanged } from '../../src/protocol/index.ts';
import {
  MemoryLock,
  MemoryStorage,
  RgsServer,
  type Broadcast,
  type Clock,
  type Crypto,
  type Entropy,
  type Lock,
  type RoundsOption,
  type Storage,
  type WriteOp,
} from '../../src/server/index.ts';

// Стенд сервера на адаптерах в памяти: сиды и id раундов по сценарию, часы стоят, оповещения — в журнал.

/** Время стенда: часы стоят, createdAt и метка карантина — это число. */
export const T0 = 1_790_000_000_000;

/** Сиды по порядку сценария; кончились — ошибка, а не повтор. id раундов — r1, r2, … */
export class ScriptedEntropy implements Entropy {
  readonly #seeds: readonly number[];
  #next = 0;
  #rounds = 0;
  readonly #bytes = new ScriptedBytes();

  constructor(seeds: readonly number[]) {
    this.#seeds = seeds;
  }

  /** Сколько сидов уже выдано. */
  get used(): number {
    return this.#next;
  }

  seed(): number {
    const seed = this.#seeds[this.#next];
    if (seed === undefined) throw new Error(`сценарий: сиды кончились на ${String(this.#next + 1)}-м`);
    this.#next += 1;
    return seed;
  }

  roundId(): string {
    this.#rounds += 1;
    return `r${String(this.#rounds)}`;
  }
  bytes(length: number): Uint8Array {
    return this.#bytes.next(length);
  }

}

export class FixedClock implements Clock {
  readonly #at: number;

  constructor(at: number) {
    this.#at = at;
  }

  now(): number {
    return this.#at;
  }
}

/** Журнал оповещений; к каждому — кошелёк, лежавший в хранилище в момент оповещения. */
export class BroadcastLog implements Broadcast {
  readonly messages: WalletChanged[] = [];
  readonly storedAtSend: unknown[] = [];
  readonly #storage: MemoryStorage;

  constructor(storage: MemoryStorage) {
    this.#storage = storage;
  }

  walletChanged(message: WalletChanged): void {
    this.messages.push(message);
    this.storedAtSend.push(this.#storage.snapshot().wallet[0]?.[1]);
  }
}

export interface RigOptions {
  readonly seeds?: readonly number[];
  readonly storage?: MemoryStorage;
  /** Обёртка над хранилищем, которое видит сервер: сбои записи, подмена между чтением и записью. */
  readonly wrap?: (inner: MemoryStorage) => Storage;
  readonly lock?: Lock;
  /** Часы сервера; по умолчанию стоят на T0. */
  readonly clock?: Clock;
  readonly maxRequests?: number;
  readonly config?: GameConfig;
  /** Источник раундов; по умолчанию — живой по сценарию сидов (честности нет). Книга — с загрузчиком. */
  readonly rounds?: RoundsOption;
  /** HMAC и SHA-256 сервера; по умолчанию node:crypto. */
  readonly crypto?: Crypto;
}

export class Rig {
  readonly storage: MemoryStorage;
  readonly entropy: ScriptedEntropy;
  readonly broadcast: BroadcastLog;
  readonly server: RgsServer;
  #id = 0;

  constructor(options: RigOptions = {}) {
    this.storage = options.storage ?? new MemoryStorage({ durable: true });
    this.entropy = new ScriptedEntropy(options.seeds ?? []);
    this.broadcast = new BroadcastLog(this.storage);
    const ports = {
      storage: options.wrap?.(this.storage) ?? this.storage,
      lock: options.lock ?? new MemoryLock(),
      clock: options.clock ?? new FixedClock(T0),
      entropy: this.entropy,
      broadcast: this.broadcast,
      crypto: options.crypto ?? new NodeCrypto(),
    };
    const config = options.config ?? DEFAULT_CONFIG;
    const rounds = options.rounds ?? { kind: 'live' };
    this.server = new RgsServer(ports, options.maxRequests === undefined ? { config, rounds } : { config, rounds, maxRequests: options.maxRequests });
  }

  /** Запрос в конверте с новым id; ответ обязан нести тот же id. Возвращает тело ответа. */
  async send(body: unknown): Promise<ResponseBody> {
    this.#id += 1;
    const response = await this.server.handle({ v: 1, id: this.#id, body });
    if (response.id !== this.#id) throw new Error(`ответ не на запрос ${String(this.#id)}`);
    return response.body;
  }
}

/** Записи мимо сервера — так тесты готовят старое и испорченное состояние хранилища. */
export async function plant(storage: MemoryStorage, ops: readonly WriteOp[]): Promise<void> {
  const outcome = await storage.commit({ precondition: () => true, ops });
  if (outcome !== 'committed') throw new Error('plant: запись не прошла');
}
