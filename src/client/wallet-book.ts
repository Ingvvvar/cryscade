/** Состояние кошелька из ответа сервера (WalletView) или из оповещения другой вкладки (walletChanged). */
export interface WalletUpdate {
  readonly balanceMinor: number;
  readonly revision: number;
  readonly notice: 'reset' | null;
}

/**
 * Кошелёк, каким его знает вкладка (§6.3). Ответы своего сервера и оповещения других вкладок приходят разными путями
 * и не по порядку: оповещение своего же воркера приходит позже его ответа. Порядок — по revision: принимается только
 * более новое. После починки хранилища revision может начаться заново — notice 'reset' принимается без сравнения и
 * становится новой точкой отсчёта.
 */
export class WalletBook {
  #balanceMinor: number | null = null;
  #revision: number | null = null;

  /** null — кошелёк ещё не известен. */
  get balanceMinor(): number | null {
    return this.#balanceMinor;
  }

  /** Принять, если новее известного. true — принято. */
  apply(update: WalletUpdate): boolean {
    const fresh = update.notice === 'reset' || this.#revision === null || update.revision > this.#revision;
    if (!fresh) return false;
    this.#balanceMinor = update.balanceMinor;
    this.#revision = update.revision;
    return true;
  }
}
