import { decodeBook, encodeBook, type Book, type BookRecord } from '../../src/server/book.ts';
import type { BookLoader } from '../../src/server/ports.ts';

// Книга для тестов сервера: три записи на сидах фикстур — проигрыш (сид 1), small-win (сид 0, 0.95×), base-win (сид 2,
// 1.90×) с весами 5, 3, 2: накопленные веса 5 | 8 | 10, W = 10. Итоги записей — те, что движок даёт на этих сидах.

export const TEST_BOOK_RECORDS: readonly BookRecord[] = [
  { seed: 1, payX100: 0, weight: 5 },
  { seed: 0, payX100: 95, weight: 3 },
  { seed: 2, payX100: 190, weight: 2 },
];

export function testBook(records: readonly BookRecord[] = TEST_BOOK_RECORDS): Book {
  const read = decodeBook(encodeBook(records), 500_000);
  if (!read.ok) throw new Error(read.problem);
  return read.book;
}

/** Загрузчик по сценарию: первые failures вызовов падают, дальше — книга. Считает вызовы. */
export class ScriptedBookLoader implements BookLoader {
  readonly #book: Book;
  #failures: number;
  calls = 0;

  constructor(book: Book = testBook(), failures = 0) {
    this.#book = book;
    this.#failures = failures;
  }

  load(): Promise<Book> {
    this.calls += 1;
    if (this.#failures > 0) {
      this.#failures -= 1;
      return Promise.reject(new Error('SHA-256 не сошёлся с эталоном'));
    }
    return Promise.resolve(this.#book);
  }
}
