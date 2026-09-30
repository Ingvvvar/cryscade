import { readdirSync } from 'node:fs';

// Где лежит книга и как её зовут: генератор, сборка (vite.config.ts вшивает хеш в воркер) и тесты находят её одинаково.

export const BOOK_DIR = 'public/books';
/** Имя файла книги: base.v1.<первые 12 знаков SHA-256 несжатых байт>.bin.gz — после деплоя кэш не отдаст старую книгу. */
export const BOOK_FILE = /^base\.v1\.([0-9a-f]{12})\.bin\.gz$/;
export const BOOK_MANIFEST = 'base.v1.json';

export function bookFileName(sha256: string): string {
  return `base.v1.${sha256.slice(0, 12)}.bin.gz`;
}

/** Единственная книга в каталоге; нет или больше одной — ошибка. */
export function findBook(dir: string = BOOK_DIR): string {
  const found = readdirSync(dir).filter((name) => BOOK_FILE.test(name));
  const [name] = found;
  if (found.length !== 1 || name === undefined) throw new Error(`в ${dir} книг ${String(found.length)}, нужна одна`);
  return name;
}
