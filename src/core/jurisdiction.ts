// Пресеты юрисдикции (§11) — данные. Код читает флаги и нигде не сравнивает имя пресета. Строгий — модель требований
// UKGC, не сертификация. Выбор пресета (?jurisdiction=strict, настройки) — в ui/; с фазы 7 — и в меню.

export interface PresetFlags {
  readonly autoplay: boolean;
  readonly turbo: boolean;
  /** Пропуск показа (slam stop): тап, пробел, «Спін» во время показа. */
  readonly skip: boolean;
  /** Спин от нажатия до готовности к следующему — не короче, мс. */
  readonly minSpinCycleMs: number;
  /** Празднование выигрыша не больше ставки: подсчёт, свечение подсветки. */
  readonly celebrateSmallWins: boolean;
  /** Чистый результат и время сессии — всегда на экране, а не в меню. */
  readonly sessionAlwaysVisible: boolean;
}

export const PRESETS = {
  standard: { autoplay: true, turbo: true, skip: true, minSpinCycleMs: 0, celebrateSmallWins: true, sessionAlwaysVisible: false },
  strict: { autoplay: false, turbo: false, skip: false, minSpinCycleMs: 2500, celebrateSmallWins: false, sessionAlwaysVisible: true },
} as const satisfies Record<string, PresetFlags>;

export type PresetName = keyof typeof PRESETS;
