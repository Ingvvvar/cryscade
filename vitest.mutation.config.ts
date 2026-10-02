import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

// Мутационный прогон (npm run mutation, tools/mutation): тот же набор, кроме тестов, которые читают исходный текст
// мутируемых файлов, — Stryker вписывает в них globalThis.__stryker__ и переключатели мутантов, и такие тесты на них не о
// том: они проверяют текст, а не поведение (запрещённые глобалы core/, AST-сканы аллокаций движка, падения и sampleScene, место
// вызова winMinor). Их держит обычный npm test. Инструментированный код медленнее: сверке книги и золотой сумме пяти
// секунд Vitest по умолчанию мало — здесь 10 минут; зависший мутант ловит таймаут Stryker.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [
        ...configDefaults.exclude,
        'tests/unit/boundaries/core-globals.test.ts',
        'tests/unit/engine/alloc-scan.test.ts',
        'tests/unit/presentation/fall-alloc.test.ts',
        'tests/unit/presentation/sample-alloc.test.ts',
        'tests/unit/server/win-minor-place.test.ts',
      ],
      testTimeout: 600_000,
    },
  }),
);
