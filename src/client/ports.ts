// Порты клиента. Логика — RgsClient, лаборатория сети, контроллер — зависит от них, а не от браузера: в тестах
// поддельные, в браузере — воркер, Web Locks, BroadcastChannel, crypto.randomUUID и таймеры (§6.5).

/** Двусторонний канал сообщений до сервера. Ответ связывает с запросом RgsClient по id конверта, не транспорт. */
export interface Transport {
  /** Отправить сообщение. Бросает, если канал не может его принять. */
  send(message: unknown): void;
  /** Подписка на входящие сообщения; возвращает отписку. */
  listen(listener: (message: unknown) => void): () => void;
}

export interface Sleep {
  /** Подождать ms. signal отменяет ожидание — тогда ответ 'aborted'. */
  sleep(ms: number, signal?: AbortSignal): Promise<'elapsed' | 'aborted'>;
}

/** Замок раунда во владении вкладки. */
export interface RoundLease {
  /** Отпустить замок. Повторный вызов и вызов после потери ничего не делают. */
  release(): void;
  /** Сбывается, когда замок отняли (steal). При release не сбывается. */
  readonly lost: Promise<void>;
}

/**
 * Замок показа раунда cryscade-round (§6.5): эксклюзивный, очередь — по приходу, как у Web Locks. Держатель —
 * вкладка, закрытие вкладки отпускает его само.
 */
export interface RoundLock {
  /** Взять, если свободен сейчас (ifAvailable); занят — null. */
  tryAcquire(): Promise<RoundLease | null>;
  /** Встать в очередь. signal снимает запрос, пока он ждёт, — промис отклоняется AbortError; после выдачи не действует. */
  acquire(signal: AbortSignal): Promise<RoundLease>;
  /** Отнять у держателя (steal): его lost сбывается, очередь остаётся за нами. */
  steal(): Promise<RoundLease>;
}

/** Сообщения других вкладок — оповещения walletChanged (§6.3). */
export interface TabChannel {
  listen(listener: (message: unknown) => void): () => void;
}

export interface KeySource {
  /** Новый ключ идемпотентности: от 1 до 64 знаков [0-9A-Za-z_-]. */
  next(): string;
}
