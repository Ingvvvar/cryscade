// Тексты интерфейса — украинский по умолчанию (§11). Словари и английский — фаза 7; здесь пока одна таблица.

import type { ClientNotice, ErrorKind } from '../client/index.ts';
import type { ErrorCode } from '../protocol/index.ts';

export const NOTICE_TEXT: Readonly<Record<ClientNotice, string>> = {
  volatile: 'Сховище браузера недоступне: гра працює, але баланс і історія не збережуться після перезавантаження',
  reset: 'Дані гри в браузері пошкоджено — баланс відновлено до 1000 кредитів',
  versionchange: 'Гру оновлено в іншій вкладці — перезавантажте',
};

export const ERROR_TEXT: Readonly<Record<ErrorKind, string>> = {
  unreachable: 'Сервер гри не відповідає',
  server: 'Сервер гри не зміг виконати запит',
  invalid: 'Відповідь сервера гри пошкоджена',
  version: 'Гру оновлено — перезавантажте сторінку',
  client: 'Гра надіслала хибний запит — перезавантажте сторінку',
};

/** Чем сервер отказал спину: спин не состоялся, деньги не двигались. */
export const REFUSAL_TEXT: Readonly<Partial<Record<ErrorCode, string>>> = {
  INSUFFICIENT_FUNDS: 'Недостатньо кредитів для ставки — поповніть баланс',
  INVALID_BET: 'Такої ставки немає',
  IDEMPOTENCY_CONFLICT: 'Спін не відбувся — спробуйте ще раз',
  ROUND_NOT_FOUND: 'Спін не відбувся — спробуйте ще раз',
};

export const TEXT = {
  menu: 'Меню',
  sound: 'Звук',
  win: 'Виграш',
  balance: 'Баланс',
  bet: 'Ставка',
  betDown: 'Зменшити ставку',
  betUp: 'Збільшити ставку',
  spin: 'Спін',
  refill: 'Поповнити',
  turbo: 'Турбо',
  auto: 'Авто',
  retry: 'Повторити',
  reload: 'Перезавантажити',
  waiting: 'Раунд іде в іншій вкладці',
  playHere: 'Грати тут',
} as const;
