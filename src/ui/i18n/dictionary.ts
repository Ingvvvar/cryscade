// Словари интерфейса (§11): украинский — по умолчанию и в начальном JS, английский — ленивым модулем (en.ts). Набор
// ключей один — тип Dictionary; тест сверяет ключи обоих словарей построчно. Надписи сцены — не здесь, а в
// scene-texts.ts: шрифту надписей они нужны сразу на обоих языках.

import type { ClientNotice, ErrorKind } from '../../client/index.ts';
import type { ErrorCode } from '../../protocol/index.ts';

export type Language = 'uk' | 'en';

export const LANGUAGES: readonly Language[] = ['uk', 'en'];

/** Название языка — на нём самом: так его находят в списке, не зная текущего. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = { uk: 'Українська', en: 'English' };

export interface Dictionary {
  readonly language: Language;
  /** Локаль сумм (Intl.NumberFormat). */
  readonly locale: string;
  readonly notice: Readonly<Record<ClientNotice, string>>;
  readonly error: Readonly<Record<ErrorKind, string>>;
  /** Чем сервер отказал спину: спин не состоялся, деньги не двигались. */
  readonly refusal: Readonly<Partial<Record<ErrorCode, string>>>;
  readonly text: {
    readonly menu: string;
    readonly sound: string;
    readonly win: string;
    readonly balance: string;
    readonly bet: string;
    readonly betDown: string;
    readonly betUp: string;
    readonly spin: string;
    readonly refill: string;
    readonly turbo: string;
    readonly auto: string;
    readonly retry: string;
    readonly reload: string;
    readonly waiting: string;
    readonly playHere: string;
    readonly replay: string;
    readonly replayExit: string;
    readonly close: string;
    readonly settings: string;
    readonly language: string;
    readonly preset: string;
    readonly presetStandard: string;
    readonly presetStrict: string;
    /** Пресет меняется со следующего раунда. */
    readonly presetNext: string;
    /** Пресет задан ссылкой (?jurisdiction=) — настройка его не меняет. */
    readonly presetLocked: string;
    readonly session: string;
    readonly sessionNet: string;
    readonly sessionTime: string;
    readonly chooseBet: string;
  };
  /** Итог раунда для экранного диктора (aria-live): один раз на раунд. Суммы — уже строками локали. */
  readonly announce: {
    win(win: string, balance: string): string;
    noWin(balance: string): string;
  };
}
