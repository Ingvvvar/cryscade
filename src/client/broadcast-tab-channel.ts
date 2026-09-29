import type { TabChannel } from './ports.ts';

/** Сообщения других вкладок (§6.3) — BroadcastChannel профиля. Канал создаёт корень композиции. */
export class BroadcastTabChannel implements TabChannel {
  readonly #channel: EventTarget;

  constructor(channel: EventTarget) {
    this.#channel = channel;
  }

  listen(listener: (message: unknown) => void): () => void {
    const handle = (event: Event): void => {
      if (event instanceof MessageEvent) listener(event.data);
    };
    this.#channel.addEventListener('message', handle);
    return () => {
      this.#channel.removeEventListener('message', handle);
    };
  }
}
