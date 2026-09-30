import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { defineConfig, type Plugin, type Rolldown, type UserConfig } from 'vite';
import { BOOK_DIR, bookIdentity, findBook } from './tools/books/files.ts';
import { BundleBudget, INITIAL_JS_BUDGET, type BudgetChunk } from './tools/bundle-budget.ts';

/**
 * Книга исходов (§5, фаза 6): эталон для воркера — SHA-256 несжатых байт, посчитанный здесь из самого файла, а не
 * прочитанный из манифеста рядом; имя файла обязано нести этот хеш — иначе кэш после деплоя отдал бы старую книгу.
 */
function bookDefines(): Record<string, string> {
  const file = findBook();
  const sha256 = bookIdentity(file, gunzipSync(readFileSync(`${BOOK_DIR}/${file}`)));
  return {
    'import.meta.env.CRYSCADE_BOOK_FILE': JSON.stringify(file),
    'import.meta.env.CRYSCADE_BOOK_SHA256': JSON.stringify(sha256),
  };
}

function chunksOf(bundle: Rolldown.OutputBundle): Map<string, BudgetChunk> {
  const chunks = new Map<string, BudgetChunk>();
  for (const item of Object.values(bundle)) {
    if (item.type === 'chunk') {
      chunks.set(item.fileName, { fileName: item.fileName, code: item.code, isEntry: item.isEntry, imports: item.imports, modules: item.moduleIds });
    }
  }
  return chunks;
}

/**
 * Гейт начального JS (§13) вместо порога Vite на размер чанка: воркер Vite собирает отдельной сборкой раньше главной —
 * его граф записывает плагин из worker.plugins, главная сверяет итог и падает сверх бюджета; ленивый модуль в начальном
 * JS роняет любую из двух сборок при любом размере.
 */
function budgetPlugins(budget: BundleBudget): { readonly main: Plugin; readonly worker: () => Plugin[] } {
  return {
    main: {
      name: 'cryscade-budget',
      apply: 'build',
      generateBundle(_options, bundle) {
        const report = budget.check(chunksOf(bundle));
        console.log(
          `[бюджет] начальный JS: ${String(report.total)} Б gzip из ${String(report.limit)} (страница ${String(report.main)}, воркеры ${String(report.workers)})`,
        );
      },
    },
    worker: () => [
      {
        name: 'cryscade-budget-worker',
        apply: 'build',
        generateBundle(_options, bundle) {
          budget.recordWorker(chunksOf(bundle));
        },
      },
    ],
  };
}

export interface CryscadeConfigOptions {
  /** Бюджет начального JS, байт gzip; по умолчанию 300 КБ. Другой — только для положительных контролей гейта. */
  readonly budget?: number;
  /** Модуль, который главный вход импортирует статически сверх своих импортов, — положительный контроль гейта. */
  readonly staticRoot?: string;
}

export function cryscadeConfig(options: CryscadeConfigOptions = {}): UserConfig {
  const budget = budgetPlugins(new BundleBudget(options.budget ?? INITIAL_JS_BUDGET));
  const staticRoot = options.staticRoot;
  const inject: Plugin[] =
    staticRoot === undefined
      ? []
      : [
          {
            name: 'cryscade-budget-control',
            enforce: 'pre',
            transform(code, id) {
              return id.endsWith('/src/ui/main.tsx') ? `import ${JSON.stringify(staticRoot)};\n${code}` : null;
            },
          },
        ];
  return {
    base: '/cryscade/',
    define: bookDefines(),
    plugins: [react(), ...inject, budget.main],
    worker: { plugins: budget.worker },
    // Порог Vite на размер чанка снят: гейт — бюджет начального JS выше.
    build: { chunkSizeWarningLimit: Number.POSITIVE_INFINITY },
  };
}

export default defineConfig(() => cryscadeConfig());
