import { gzipSync } from 'node:zlib';

// Бюджет начального JS (§13): ≤ 300 КБ gzip без книги — вход страницы и его статические импорты плюс каждый воркер
// и его статические импорты: воркер сервера грузится сразу. Ленивое (динамический импорт) — вне бюджета. Гейт роняет
// сборку по двум условиям: начальный JS сверх бюджета — и модуль из ленивого списка в начальном JS, при любом размере.
// Это наш гейт вместо порога Vite на размер чанка. Граф — из generateBundle сборки; воркер Vite собирает отдельной
// сборкой, поэтому её граф записывается раньше, чем главная сборка сверяет итог.

export const INITIAL_JS_BUDGET = 300 * 1024;

/**
 * Ленивое §13, которое уже есть в коде, — пути от корня проекта. Модуль из списка в статическом замыкании входа или
 * воркера роняет сборку, сколько бы он ни весил. Диалоги и английский словарь (фаза 7), звук (фаза 8) входят в список
 * со своими фазами; книга (фаза 6) — файл данных, а не модуль. Каждый модуль списка ловит положительный контроль
 * tests/e2e/bundle.spec.ts: контрольная сборка импортирует их все статически и обязана упасть, назвав каждый.
 */
export const LAZY_MODULES: readonly string[] = [
  'src/ui/probe.ts',
  'src/ui/i18n/en.ts',
  'src/ui/dialogs/settings-dialog.tsx',
  'src/ui/dialogs/rules-dialog.tsx',
  'src/ui/dialogs/history-dialog.tsx',
  'src/ui/dialogs/fairness-dialog.tsx',
  'src/ui/dialogs/lab-dialog.tsx',
  'src/audio/index.ts',
  'src/audio/director.ts',
  'src/audio/cues.ts',
  'src/audio/synth.ts',
];

/** Что бюджету нужно от чанка сборки. */
export interface BudgetChunk {
  readonly fileName: string;
  readonly code: string;
  readonly isEntry: boolean;
  /** Статические импорты — имена файлов чанков. */
  readonly imports: readonly string[];
  /** Модули чанка — абсолютные пути (moduleIds Rolldown), бывают с запросом после «?». */
  readonly modules: readonly string[];
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

interface BudgetReport {
  readonly limit: number;
  readonly main: number;
  readonly workers: number;
  readonly total: number;
  readonly files: readonly string[];
}

/**
 * Счёт одной сборки: сперва воркеры, потом главная. Ленивый модуль в начальном JS — ошибка сразу, сверх бюджета — ошибка
 * с разбивкой. Порог — безопасное целое больше нуля: иначе сравнение с ним молча пропускало бы любой размер (NaN).
 */
export class BundleBudget {
  readonly #limit: number;
  readonly #lazy: readonly string[];
  readonly #workerFiles: string[] = [];
  #workers = 0;

  constructor(limit: number = INITIAL_JS_BUDGET, lazy: readonly string[] = LAZY_MODULES) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError(`бюджет начального JS — безопасное целое больше нуля, байт gzip; получено ${String(limit)}`);
    }
    this.#limit = limit;
    this.#lazy = lazy;
  }

  /** Сборка воркера: его вход и статические импорты. */
  recordWorker(chunks: ReadonlyMap<string, BudgetChunk>): void {
    const files = initialFiles(chunks);
    this.#refuseLazy(files, chunks);
    for (const file of files) {
      this.#workerFiles.push(file);
      this.#workers += gzipBytes(chunks.get(file)?.code ?? '');
    }
  }

  /** Главная сборка: вход страницы, статические импорты и записанные воркеры. */
  check(chunks: ReadonlyMap<string, BudgetChunk>): BudgetReport {
    const files = initialFiles(chunks);
    this.#refuseLazy(files, chunks);
    const main = files.reduce((sum, file) => sum + gzipBytes(chunks.get(file)?.code ?? ''), 0);
    const report = { limit: this.#limit, main, workers: this.#workers, total: main + this.#workers, files: [...files, ...this.#workerFiles] };
    if (report.total > this.#limit) {
      throw new Error(`начальный JS ${String(report.total)} Б gzip больше бюджета ${String(this.#limit)} Б: страница ${String(main)}, воркеры ${String(this.#workers)}; файлы: ${report.files.join(', ')}`);
    }
    return report;
  }

  /** Модуль ленивого списка среди модулей начальных файлов — отказ при любом размере. */
  #refuseLazy(files: readonly string[], chunks: ReadonlyMap<string, BudgetChunk>): void {
    const found: string[] = [];
    for (const file of files) {
      for (const id of chunks.get(file)?.modules ?? []) {
        const path = id.split('?')[0] ?? id;
        const lazy = this.#lazy.find((module) => path.endsWith(`/${module}`));
        if (lazy !== undefined) found.push(`${lazy} в ${file}`);
      }
    }
    if (found.length > 0) throw new Error(`ленивый модуль в начальном JS — его место за динамическим импортом (§13): ${found.join(', ')}`);
  }
}
