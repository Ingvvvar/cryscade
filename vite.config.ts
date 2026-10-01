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
  /** Модули, которые главный вход импортирует статически сверх своих импортов, — положительный контроль гейта. */
  readonly staticRoots?: readonly string[];
  /**
   * Профилирующий react-dom вместо прод-сборки (только e2e): у прод-сборки Profiler не зовёт onRender, а замер рендеров
   * App за раунд (§11) идёт в e2e. Прод не меняется.
   */
  readonly profiling?: boolean;
}

export function cryscadeConfig(options: CryscadeConfigOptions = {}): UserConfig {
  const budget = budgetPlugins(new BundleBudget(options.budget ?? INITIAL_JS_BUDGET));
  const staticRoots = options.staticRoots ?? [];
  const inject: Plugin[] =
    staticRoots.length === 0
      ? []
      : [
          {
            name: 'cryscade-budget-control',
            enforce: 'pre',
            transform(code, id) {
              return id.endsWith('/src/ui/main.tsx') ? `${staticRoots.map((root) => `import ${JSON.stringify(root)};`).join('\n')}\n${code}` : null;
            },
          },
        ];
  return {
    base: '/cryscade/',
    define: bookDefines(),
    ...(options.profiling === true ? { resolve: { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] } } : {}),
    plugins: [react(), ...inject, budget.main],
    worker: { plugins: budget.worker },
    // Порог Vite на размер чанка снят: гейт — бюджет начального JS выше.
    build: { chunkSizeWarningLimit: Number.POSITIVE_INFINITY },
  };
}

export default defineConfig(({ mode }) => cryscadeConfig({ profiling: mode === 'e2e' }));
