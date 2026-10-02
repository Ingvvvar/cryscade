// Области мутационного тестирования (§14, фаза 9): что мутируется и какими тестами. Раннер — command (StrykerJS гоняет
// команду на каждого мутанта): раннер vitest 10.0.0 на Vitest 5.0.1 прикладывал к мутантам единицы тестов вместо набора
// — заведомо смертельные мутанты «выживали» (проба фазы 9, «Решения на ревью»). Тесты области — тесты её модуля и того,
// что его прямо проверяет: FSM — ещё контроллер, расписание — ещё часы показа, сервер — ещё мир кошелька и вкладок.

export interface Area {
  readonly key: 'engine' | 'fsm' | 'schedule' | 'server';
  readonly name: string;
  /** Пути относительно корня: по ним сводка относит мутанта к области. */
  readonly prefixes: readonly string[];
  readonly mutate: readonly string[];
  /** Быстрые тесты — первым шагом: убитый ими мутант до тяжёлых не доходит. */
  readonly tests: readonly string[];
  /** Тяжёлые (property, симуляции, сверка книги) — вторым шагом, только для мутанта, которого быстрые не убили. */
  readonly slowTests: readonly string[];
}

export const AREAS: readonly Area[] = [
  {
    key: 'engine',
    name: 'движок',
    prefixes: ['src/core/engine/', 'src/core/rng/'],
    mutate: ['src/core/engine/**/*.ts', 'src/core/rng/**/*.ts'],
    tests: ['tests/unit/engine', 'tests/unit/rng', 'tests/unit/fixtures.test.ts'],
    slowTests: ['tests/property/engine.property.test.ts', 'tests/unit/math/quick.test.ts'],
  },
  {
    key: 'fsm',
    name: 'FSM',
    prefixes: ['src/core/fsm/'],
    mutate: ['src/core/fsm/**/*.ts'],
    tests: ['tests/unit/fsm'],
    slowTests: ['tests/property/fsm.property.test.ts', 'tests/unit/client/game-controller.test.ts'],
  },
  {
    key: 'schedule',
    name: 'расписание',
    prefixes: ['src/core/presentation/'],
    mutate: ['src/core/presentation/**/*.ts'],
    tests: ['tests/unit/presentation', 'tests/unit/client/presenter.test.ts'],
    slowTests: ['tests/property/presentation.property.test.ts'],
  },
  {
    key: 'server',
    name: 'логика сервера',
    prefixes: ['src/server/'],
    mutate: ['src/server/**/*.ts', '!src/server/worker.ts', '!src/server/**/*.d.ts'],
    tests: ['tests/unit/server', 'tests/unit/books/collector.test.ts', 'tests/unit/books/select.test.ts'],
    slowTests: [
      'tests/unit/books/book-file.test.ts',
      'tests/property/wallet.property.test.ts',
      'tests/property/wallet-cas.property.test.ts',
      'tests/property/storage-damage.property.test.ts',
      'tests/property/storage-invariant.property.test.ts',
      'tests/property/integer-fields.property.test.ts',
      'tests/property/tabs.property.test.ts',
    ],
  },
];

/**
 * Команда тестов области для command runner: обычный Vitest на конфиге мутаций, два шага через && — быстрые тесты,
 * потом тяжёлые; --bail=1 — первый провал останавливает шаг. Один форк Vitest: StrykerJS гоняет пять прогонов разом
 * (stryker.config.json), и пулы Vitest в каждом давали нагрузку 30 на 10 ядрах — очередь к процессору грозит ложными
 * таймаутами (таймаут Stryker засчитывает как убийство).
 */
export function testCommand(area: Area): string {
  const vitest = (files: readonly string[]): string => `npx vitest run --config vitest.mutation.config.ts --maxWorkers=1 --bail=1 ${files.join(' ')}`;
  return area.slowTests.length === 0 ? vitest(area.tests) : `${vitest(area.tests)} && ${vitest(area.slowTests)}`;
}
