// Сиды принудительных раундов (dev и e2e, фаза 5): зонд задаёт сид следующего раунда — фичу и большой выигрыш не ждать
// сотни спинов. Сиды фикстур — из fixtures/rounds; уровни большого выигрыша 2 и 3 нашёл движок
// (node tools/math/big-win-seeds.ts) — литералами, тест сверяет их движком заново. Грузит их только зонд.

export const FORCED_SEEDS = {
  loss: 1,
  smallWin: 0,
  baseWin: 2,
  cascade: 512,
  multiplier: 12387,
  feature: 48,
  retrigger: 3407,
  /** 33.50× — «Великий виграш» (это же раунд фичи). */
  bigWin1: 48,
  /** 72.00× — «Величезний виграш». */
  bigWin2: 1590,
  /** 153.90× — «Епічний виграш». */
  bigWin3: 466,
  /** Кап 5000× — «Максимальний виграш». */
  maxWin: 801200,
} as const;

export type ForcedName = keyof typeof FORCED_SEEDS;
