// Словари интерфейса (§11): украинский — по умолчанию и в начальном JS, английский — ленивым модулем (en.ts). Набор
// ключей один — тип Dictionary; тест сверяет ключи обоих словарей построчно. Надписи сцены — не здесь, а в
// scene-texts.ts: шрифту надписей они нужны сразу на обоих языках.

import type { ClientNotice, ErrorKind } from '../../client/index.ts';
import type { ErrorCode } from '../../protocol/index.ts';
import type { AutoplayStop } from '../autoplay.ts';

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
    readonly soundOn: string;
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
    readonly rules: string;
    readonly history: string;
    readonly fairness: string;
    readonly lab: string;
    readonly loading: string;
    /** Запрос не удался: сервер не ответил или ответ не годится. */
    readonly failed: string;
    /** Эконом-режим без аппаратного ускорения (§10) — полоса уведомлений, один раз за загрузку. */
    readonly economy: string;
  };
  /** Правила и выплаты (§11): числа — из конфига модели. */
  readonly rules: {
    /** Названия платящих символов по id 0…6. */
    readonly symbols: readonly [string, string, string, string, string, string, string];
    /** Название скаттера — ядра (id 7): подпись его иконки в абзаце про фичу. */
    readonly core: string;
    readonly symbol: string;
    readonly table: string;
    clusters(min: number): string;
    readonly cascades: string;
    spots(max: number): string;
    /** list — «3 — 10, 4 — 12, …», собранный из конфига. */
    feature(list: string): string;
    /** Последняя ступень списка фриспинов — «6 і більше». */
    orMore(count: number): string;
    retrigger(min: number, add: number): string;
    cap(times: string): string;
    readonly rtp: string;
  };
  readonly history: {
    readonly time: string;
    readonly bet: string;
    readonly win: string;
    readonly book: string;
    readonly nonce: string;
    readonly check: string;
    readonly replay: string;
    readonly empty: string;
    /** Раунд до честности (живой ГСЧ) и принудительный — их не проверить. */
    readonly live: string;
    readonly forced: string;
    /** Секрет раунда ещё не раскрыт: проверка — после смены сида или секрета. */
    readonly hidden: string;
    readonly match: string;
    readonly mismatch: string;
  };
  readonly fairness: {
    readonly commitment: string;
    readonly clientSeed: string;
    readonly nonce: string;
    readonly changeSeed: string;
    readonly rotate: string;
    readonly revealed: string;
    readonly seedHint: string;
    readonly roundActive: string;
    readonly verify: string;
    readonly secret: string;
    readonly badSecret: string;
    readonly badSeed: string;
    readonly badNonce: string;
    /** Итог пересчёта: запись книги и выплата. */
    result(index: number, pay: string): string;
    foundMatch(time: string): string;
    foundMismatch(time: string): string;
    readonly notFound: string;
    readonly replayOnly: string;
  };
  /** Автоигра (§11): настройки серии, полоса хода и причина остановки. */
  readonly autoplay: {
    readonly title: string;
    readonly count: string;
    readonly lossLimit: string;
    readonly stopOnFeature: string;
    readonly stopOnWin: string;
    readonly start: string;
    readonly stop: string;
    left(count: number): string;
    readonly stopped: Readonly<Record<AutoplayStop, string>>;
    readonly dismiss: string;
  };
  /** Лаборатория сети (§6.5): поля настроек, разовые действия и что сделано. */
  readonly lab: {
    readonly intro: string;
    readonly fields: { readonly latencyMs: string; readonly jitterMs: string; readonly requestLoss: string; readonly responseLoss: string };
    readonly clear: string;
    readonly cleared: string;
    readonly actionsTitle: string;
    readonly actions: { readonly loseNextResponse: string; readonly reloadMidNextRound: string; readonly holdNextEndRound: string; readonly releaseHeld: string };
    readonly done: { readonly loseNextResponse: string; readonly reloadMidNextRound: string; readonly holdNextEndRound: string; readonly releaseHeld: string };
  };
  /** Итог раунда для экранного диктора (aria-live): один раз на раунд. Суммы — уже строками локали. */
  readonly announce: {
    win(win: string, balance: string): string;
    noWin(balance: string): string;
  };
}
