// Ссылка повтора (§7, фаза 6): ?replay=round:<id> — раунд своей истории, ?replay=book:<index> — запись книги в любом
// браузере. Разбор строгий: чужой формат — не повтор, а обычный запуск.

import type { ReplayTarget } from '../client/index.ts';

/** Записей в книге не больше 80 000 (§5): индекс — от 0 до 79 999. */
const BOOK_INDEX_LIMIT = 80_000;

export function replayTarget(search: string): ReplayTarget | null {
  const raw = new URLSearchParams(search).get('replay');
  if (raw === null) return null;
  const round = /^round:([\w-]{1,64})$/.exec(raw)?.[1];
  if (round !== undefined) return { round };
  const book = /^book:(0|[1-9]\d{0,4})$/.exec(raw)?.[1];
  if (book === undefined) return null;
  const index = Number(book);
  return index < BOOK_INDEX_LIMIT ? { book: index } : null;
}

/** Выход из повтора — обычный запуск: тот же адрес без ?replay. */
export function replayExit(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('replay');
  return url.toString();
}
