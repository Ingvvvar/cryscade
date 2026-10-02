// @ts-check
// Конфиг на JS: ESLint 10 грузит .ts только через jiti или нестабильный флаг.
// Тип проверяет tsc (tsconfig.node.json, checkJs).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
// Node 24+ импортирует .ts сам (type stripping) — правило пишется на TS без сборки.
import { deterministicMath } from './lint/deterministic-math.ts';
import { noModuleState } from './lint/no-module-state.ts';

// Свои правила — один объект плагина: ESLint не даёт определить плагин с тем же именем дважды.
const cryscade = { rules: { 'no-module-state': noModuleState, 'deterministic-math': deterministicMath } };

// Зеркало границ §3. Линтер видит только строку импорта, поэтому правила — по сегментам пути.
// Источник истины — тест графа импортов: он разрешает реальные пути и проверяет замыкание.

/**
 * @param {string} regex
 * @param {string} message
 */
const pattern = (regex, message) => ({ regex, message });

/** @param {string[]} names */
const leave = (names) =>
  pattern(`(^|/)(${names.join('|')})(/|$)`, `Граница §3: модуль не может импортировать ${names.join(', ')}.`);

/** @param {string[]} allowed */
const packagesExcept = (allowed) =>
  pattern(
    allowed.length === 0 ? '^(?![./])' : `^(?![./]|(${allowed.join('|')})(/|$))`,
    allowed.length === 0
      ? 'Граница §3: модулю не разрешены внешние пакеты.'
      : `Граница §3: из внешних пакетов модулю разрешены только ${allowed.join(', ')}.`,
  );

/** @param {string} allowed — альтернативы после core/, которые модулю разрешены */
const coreOnly = (allowed) =>
  pattern(`(^|/)core/(?!${allowed})`, 'Граница §3: из core/ модулю разрешены не все части.');

/**
 * @param {string[]} files
 * @param {{ regex: string; message: string }[]} patterns
 * @returns {import('eslint').Linter.Config}
 */
const boundary = (files, patterns) => ({
  files,
  rules: { 'no-restricted-imports': ['error', { patterns }] },
});

// ООП (CLAUDE.md): приватное — через #, не private.
const NO_PRIVATE = { selector: '[accessibility="private"]', message: 'Приватное — через #, не private.' };

const CORE_LEAVE = leave(['protocol', 'server', 'client', 'render', 'ui', 'audio', 'tools', 'fixtures']);
const CORE_PURE = ['src/core/model/**', 'src/core/fsm/**', 'src/core/presentation/**', 'src/core/money.ts', 'src/core/jurisdiction.ts'];

export default defineConfig([
  globalIgnores(['dist/', 'dist-e2e/', 'playwright-report/', 'test-results/', 'blob-report/', 'coverage/', 'reports/', '.stryker-tmp/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
  },

  boundary(['src/core/**'], [packagesExcept([]), CORE_LEAVE]),
  boundary(CORE_PURE, [
    packagesExcept([]),
    CORE_LEAVE,
    pattern('(^|/)(engine|rng)(/|$)', 'Граница §3: model, money, jurisdiction, fsm, presentation не импортируют engine и rng.'),
  ]),
  boundary(['src/protocol/**'], [packagesExcept([]), leave(['server', 'client', 'render', 'ui', 'audio', 'tools', 'fixtures']), coreOnly('model/')]),
  boundary(['src/server/**'], [packagesExcept([]), leave(['client', 'render', 'ui', 'audio', 'tools', 'fixtures'])]),
  boundary(['src/client/**'], [
    packagesExcept([]),
    leave(['server', 'render', 'ui', 'audio', 'tools', 'fixtures']),
    coreOnly('(model|fsm|presentation)/|(jurisdiction|money)\\.ts$'),
  ]),
  // Pixi — только в render/pixi/: остальной render/ без пакетов и без render/pixi/. Блок render/pixi/** идёт
  // следом и для своих файлов заменяет правило целиком.
  boundary(['src/render/**'], [packagesExcept([]), leave(['server', 'client', 'ui', 'audio', 'tools', 'fixtures', 'pixi']), coreOnly('(model|presentation)/')]),
  boundary(['src/render/pixi/**'], [packagesExcept(['pixi\\.js']), leave(['server', 'client', 'ui', 'audio', 'tools', 'fixtures']), coreOnly('(model|presentation)/')]),
  boundary(['src/ui/**'], [
    packagesExcept(['react', 'react-dom', '@fontsource-variable/unbounded', '@fontsource-variable/manrope']),
    leave(['server', 'tools', 'fixtures']),
    coreOnly('model/'),
  ]),
  boundary(['src/audio/**'], [packagesExcept([]), leave(['server', 'client', 'render', 'ui', 'tools', 'fixtures']), coreOnly('(model|presentation)/')]),
  boundary(['tools/**'], [packagesExcept(['node:[^/]+']), leave(['client', 'render', 'ui', 'audio', 'fixtures'])]),

  {
    // ООП в коде игры (CLAUDE.md). tests/ и tools/ не затрагивает.
    files: ['src/**'],
    plugins: { cryscade },
    rules: {
      'cryscade/no-module-state': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      'no-restricted-syntax': ['error', NO_PRIVATE],
    },
  },

  {
    // Файл в src/ вне модулей таблицы §3 — нарушение, а не слепая зона.
    // no-restricted-syntax здесь заменяет правило блока выше, поэтому NO_PRIVATE повторён.
    files: ['src/*', 'src/!(core|protocol|server|client|render|ui|audio)/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        NO_PRIVATE,
        { selector: 'Program', message: 'Граница §3: файл в src/ вне модулей таблицы.' },
      ],
    },
  },

  {
    files: ['src/core/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['Date', 'performance', 'crypto', 'window', 'document', 'navigator', 'self', 'globalThis'].map((name) => ({
          name,
          message: 'В core/ нет времени, случайности, crypto и DOM.',
        })),
      ],
      'no-restricted-properties': ['error', { object: 'Math', property: 'random', message: 'В core/ нет Math.random.' }],
    },
  },

  {
    // Браузер, время и случайность в server/ — только в worker.ts (§3); логика сервера — на портах.
    // Зеркало скана tests/unit/boundaries/server-globals.test.ts.
    files: ['src/server/**'],
    ignores: ['src/server/worker.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...[
          'Date',
          'performance',
          'crypto',
          'window',
          'document',
          'navigator',
          'self',
          'globalThis',
          'indexedDB',
          'IDBKeyRange',
          'BroadcastChannel',
          'postMessage',
          'importScripts',
          'location',
          'caches',
          'fetch',
          'setTimeout',
          'setInterval',
        ].map((name) => ({ name, message: 'В server/ браузер, время и случайность — только в worker.ts, остальное — через порты.' })),
      ],
      'no-restricted-properties': ['error', { object: 'Math', property: 'random', message: 'В server/ случайность — через порт Entropy.' }],
    },
  },

  {
    // Детерминизм между движками JS (§4.7): книгу строит V8, повтор может пересчитать Safari.
    files: ['src/core/engine/**', 'src/core/rng/**', 'src/core/money.ts'],
    rules: { 'cryscade/deterministic-math': 'error' },
  },
]);
