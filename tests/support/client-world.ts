import {
  GameController,
  MemoryRoundLock,
  NetworkLabTransport,
  RgsClient,
  TimeoutSleep,
  type ControllerSnapshot,
  type KeySource,
  type RoundLock,
  type TabChannel,
  type Transport,
} from '../../src/client/index.ts';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import { isRecord, type RequestBody, type WalletChanged } from '../../src/protocol/index.ts';
import { MemoryLock, MemoryStorage, RgsServer, type Entropy, type Storage } from '../../src/server/index.ts';
import { FixedClock, T0 } from './rgs-rig.ts';

// Профиль браузера для контроллеров в Node: общее хранилище, общий замок кошелька и замок раунда (Web Locks),
// BroadcastChannel. У каждой вкладки свой воркер — свой RgsServer на общем хранилище, — своя лаборатория сети,
// свой RgsClient и контроллер. Время — поддельные таймеры Vitest: тест включает их сам.

/**
 * BroadcastChannel профиля: оповещение сервера любой вкладки доходит до всех вкладок, и до своей тоже, — таймером,
 * то есть позже прямого ответа воркера. Так в Chrome: проба шага Б, 200 из 200.
 */
export class Bus {
  readonly sent: WalletChanged[] = [];
  readonly #listeners = new Set<(message: unknown) => void>();

  post(message: WalletChanged): void {
    this.sent.push(message);
    const copy = structuredClone(message);
    setTimeout(() => {
      for (const listener of [...this.#listeners]) listener(structuredClone(copy));
    }, 0);
  }

  channel(): TabChannel {
    return {
      listen: (listener) => {
        this.#listeners.add(listener);
        return () => {
          this.#listeners.delete(listener);
        };
      },
    };
  }
}

/** Воркер вкладки: запрос — копией в сервер, ответ — копией назад. Закрыт — не доставляет ни запросов, ни ответов. */
export class WorkerPort implements Transport {
  /** Тела запросов, дошедших до сервера, по порядку. */
  readonly received: RequestBody[] = [];
  readonly #server: RgsServer;
  readonly #listeners = new Set<(message: unknown) => void>();
  #closed = false;

  constructor(server: RgsServer) {
    this.#server = server;
  }

  send(message: unknown): void {
    if (this.#closed) return;
    const copy: unknown = structuredClone(message);
    queueMicrotask(() => {
      void this.#handle(copy);
    });
  }

  listen(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    this.#closed = true;
  }

  /** Сообщение воркера без запроса — например, storageClosed. Доходит и до закрытого порта: слушать его — дело вкладки. */
  push(message: unknown): void {
    const copy: unknown = structuredClone(message);
    for (const listener of [...this.#listeners]) listener(copy);
  }

  async #handle(message: unknown): Promise<void> {
    if (!this.#open()) return;
    if (isRecord(message)) this.received.push(message['body'] as RequestBody);
    const response = await this.#server.handle(message);
    // Вкладку закрыли, пока сервер работал: запись могла состояться, ответ уже некому получить.
    if (!this.#open()) return;
    const copy: unknown = structuredClone(response);
    for (const listener of [...this.#listeners]) listener(copy);
  }

  #open(): boolean {
    return !this.#closed;
  }
}

/** Сиды по кругу; id раундов — с именем вкладки, чтобы серверы двух вкладок их не путали. */
class TabEntropy implements Entropy {
  readonly #seeds: readonly number[];
  readonly #prefix: string;
  #next = 0;
  #rounds = 0;

  constructor(seeds: readonly number[], prefix: string) {
    this.#seeds = seeds;
    this.#prefix = prefix;
  }

  seed(): number {
    const seed = this.#seeds[this.#next % this.#seeds.length];
    if (seed === undefined) throw new Error('вкладка: сиды не заданы');
    this.#next += 1;
    return seed;
  }

  roundId(): string {
    this.#rounds += 1;
    return `${this.#prefix}r${String(this.#rounds)}`;
  }
}

class SequentialKeys implements KeySource {
  readonly #prefix: string;
  #count = 0;

  constructor(prefix: string) {
    this.#prefix = prefix;
  }

  next(): string {
    this.#count += 1;
    return `${this.#prefix}k${String(this.#count)}`;
  }
}

export interface TabOptions {
  /** Сиды раундов сервера вкладки. По умолчанию — 0: small-win, ставка 100 → выигрыш 35. */
  readonly seeds?: readonly number[];
  /** Своё хранилище вместо общего: так вкладка видит IndexedDB недоступной. */
  readonly storage?: Storage;
  /** Обёртка над хранилищем, которое видит сервер вкладки. */
  readonly wrapStorage?: (inner: Storage) => Storage;
  /** Обёртка над воркером — порча и подмена ответов. */
  readonly wrapPort?: (port: WorkerPort) => Transport;
  /** Обёртка над общим замком раунда — придержать выдачу. */
  readonly wrapLock?: (lock: RoundLock) => RoundLock;
  /** Сервер вкладки не пишет в общий канал — так воркер в памяти не путает вкладки с IndexedDB (шаг В). */
  readonly silent?: boolean;
}

export class Tab {
  /** Префикс ключей и id раундов вкладки. */
  readonly name: string;
  readonly port: WorkerPort;
  readonly lab: NetworkLabTransport;
  readonly client: RgsClient;
  readonly controller: GameController;
  /** Каждый опубликованный снимок — чтобы видеть не только итог, но и путь к нему. */
  readonly snapshots: ControllerSnapshot[] = [];
  reloads = 0;

  constructor(name: string, world: ClientWorld, options: TabOptions) {
    this.name = name;
    const storage = options.storage ?? world.storage;
    const server = new RgsServer(
      {
        storage: options.wrapStorage?.(storage) ?? storage,
        lock: world.walletLock,
        clock: new FixedClock(T0),
        entropy: new TabEntropy(options.seeds ?? [0], name),
        broadcast: {
          walletChanged: (message) => {
            if (options.silent !== true) world.bus.post(message);
          },
        },
      },
      { config: DEFAULT_CONFIG },
    );
    this.port = new WorkerPort(server);
    const sleep = new TimeoutSleep();
    this.lab = new NetworkLabTransport(options.wrapPort?.(this.port) ?? this.port, sleep, {
      random: () => 0.5,
      reload: () => {
        this.reloads += 1;
      },
    });
    this.client = new RgsClient(this.lab, sleep);
    this.controller = new GameController({
      rgs: this.client,
      roundLock: options.wrapLock?.(world.roundLock) ?? world.roundLock,
      localLock: new MemoryRoundLock(),
      channel: world.bus.channel(),
      notices: this.port,
      keys: new SequentialKeys(name),
    });
    this.controller.subscribe(() => {
      this.snapshots.push(this.controller.getSnapshot());
    });
  }

  get state(): ControllerSnapshot['state'] {
    return this.controller.getSnapshot().state;
  }

  get snapshot(): ControllerSnapshot {
    return this.controller.getSnapshot();
  }

  /** Типы запросов, дошедших до сервера вкладки. */
  get calls(): string[] {
    return this.port.received.map((body) => body.type);
  }

  /** Вкладку закрыли: воркер остановлен, замок отпущен браузером. */
  close(): void {
    this.controller.dispose();
    this.client.dispose();
    this.port.close();
  }
}

export class ClientWorld {
  readonly storage = new MemoryStorage({ durable: true });
  readonly walletLock = new MemoryLock();
  readonly roundLock = new MemoryRoundLock();
  readonly bus = new Bus();

  /** Открыть вкладку и запустить контроллер. */
  open(name: string, options: TabOptions = {}): Tab {
    const tab = new Tab(name, this, options);
    tab.controller.start();
    return tab;
  }

  /** Занят ли замок раунда сейчас — глазами третьей вкладки. */
  async lockFree(): Promise<boolean> {
    const lease = await this.roundLock.tryAcquire();
    lease?.release();
    return lease !== null;
  }
}
