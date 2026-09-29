import { gzipSync } from 'node:zlib';

// Бюджет начального JS (§13): ≤ 300 КБ gzip без книги — вход страницы и его статические импорты плюс каждый воркер
// и его статические импорты: воркер сервера грузится сразу. Ленивое (динамический импорт) — вне бюджета. Сборка
// сверх бюджета падает: это наш гейт вместо порога Vite на размер чанка. Граф — из generateBundle сборки; воркер Vite
// собирает отдельной сборкой, поэтому её граф записывается раньше, чем главная сборка сверяет итог.

export const INITIAL_JS_BUDGET = 300 * 1024;

/** Что бюджету нужно от чанка сборки. */
export interface BudgetChunk {
  readonly fileName: string;
  readonly code: string;
  readonly isEntry: boolean;
  /** Статические импорты — имена файлов чанков. */
  readonly imports: readonly string[];
}

/** Файлы, которые грузятся сразу: входы и всё, что они тянут статическими импортами. */
export function initialFiles(chunks: ReadonlyMap<string, BudgetChunk>): string[] {
  const seen = new Set<string>();
  const queue = [...chunks.values()].filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...(chunks.get(file)?.imports ?? []));
  }
  return [...seen].sort();
}

export function gzipBytes(code: string): number {
  return gzipSync(code).length;
}

export interface BudgetReport {
  readonly limit: number;
  readonly main: number;
  readonly workers: number;
  readonly total: number;
  readonly files: readonly string[];
}

/** Счёт одной сборки: сперва воркеры, потом главная. Сверх бюджета — ошибка с разбивкой. */
export class BundleBudget {
  readonly #limit: number;
  readonly #workerFiles: string[] = [];
  #workers = 0;

  constructor(limit: number = INITIAL_JS_BUDGET) {
    this.#limit = limit;
  }

  /** Сборка воркера: его вход и статические импорты. */
  recordWorker(chunks: ReadonlyMap<string, BudgetChunk>): void {
    for (const file of initialFiles(chunks)) {
      this.#workerFiles.push(file);
      this.#workers += gzipBytes(chunks.get(file)?.code ?? '');
    }
  }

  /** Главная сборка: вход страницы, статические импорты и записанные воркеры. */
  check(chunks: ReadonlyMap<string, BudgetChunk>): BudgetReport {
    const files = initialFiles(chunks);
    const main = files.reduce((sum, file) => sum + gzipBytes(chunks.get(file)?.code ?? ''), 0);
    const report = { limit: this.#limit, main, workers: this.#workers, total: main + this.#workers, files: [...files, ...this.#workerFiles] };
    if (report.total > this.#limit) {
      throw new Error(`начальный JS ${String(report.total)} Б gzip больше бюджета ${String(this.#limit)} Б: страница ${String(main)}, воркеры ${String(this.#workers)}; файлы: ${report.files.join(', ')}`);
    }
    return report;
  }
}
