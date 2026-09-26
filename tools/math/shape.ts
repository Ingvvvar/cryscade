// Семейства параметров подбора: веса по ярусам — геометрически, таблица — черновик §4.4 × k, полоса 5–6 — ещё × m,
// с «красивым» округлением. Дешевеет только нижняя полоса, верхние сохраняют пропорции черновика: до капа доводят
// множители и каскады, а не один кластер. Структура не меняется: 7 символов, 6 полос, награды и ретриггер — как в §4.2.

export const WEIGHT_TOTAL = 10_000;

/**
 * Веса 7 платящих символов пропорционально r^ярус (Кварц — ярус 0, Бриллиант — 6), ядро — scatter, сумма — 10 000.
 * Округление вниз, остаток — по наибольшим дробным частям, при равенстве — младшему символу.
 */
export function geometricWeights(ratio: number, scatter: number): number[] {
  if (!(ratio > 0) || !Number.isInteger(scatter) || scatter < 0 || scatter >= WEIGHT_TOTAL) {
    throw new RangeError(`веса: r ${String(ratio)}, ядро ${String(scatter)}`);
  }
  const paying = WEIGHT_TOTAL - scatter;
  const raw = Array.from({ length: 7 }, (_, tier) => ratio ** tier);
  const sum = raw.reduce((a, b) => a + b, 0);
  const exact = raw.map((value) => (paying * value) / sum);
  const weights = exact.map(Math.floor);
  const order = exact.map((value, tier) => ({ tier, part: value - Math.floor(value) })).sort((a, b) => b.part - a.part || a.tier - b.tier);
  for (let left = paying - weights.reduce((a, b) => a + b, 0), index = 0; left > 0; left--, index++) {
    const tier = order[index]?.tier ?? 0;
    weights[tier] = (weights[tier] ?? 0) + 1;
  }
  return [...weights, scatter];
}

/** Черновик таблицы §4.4 в сотых долях ставки — основа масштаба. */
export const DRAFT_PAYTABLE_X100: readonly (readonly number[])[] = [
  [20, 40, 80, 150, 300, 600],
  [25, 50, 100, 200, 400, 800],
  [30, 60, 120, 250, 500, 1000],
  [40, 80, 160, 300, 600, 1200],
  [60, 120, 250, 500, 1000, 2500],
  [80, 160, 350, 700, 1500, 4000],
  [100, 250, 500, 1000, 2500, 10000],
];

/** Самая дорогая клетка таблицы — не дороже 1000× (100 000 сотых): один кластер кап не даёт. */
export const MAX_CELL_X100 = 100_000;

/** Множитель полосы b (0 — полоса 5–6): нижняя дешевеет в m раз, остальные — как в черновике. */
export function bandFactor(band: number, low: number): number {
  return band === 0 ? low : 1;
}

/** Черновик × k, полоса 5–6 × m, с округлением до целых сотых — для стадий подбора до красивого округления. */
export function scaledTable(k: number, low = 1): number[][] {
  return DRAFT_PAYTABLE_X100.map((row) => row.map((value, band) => Math.max(1, Math.round(value * k * bandFactor(band, low)))));
}

/** Шаг красивого значения: ниже 1× — 0.05, до 10× — 0.1, от 10× — 1×. */
export function niceStepX100(valueX100: number): number {
  if (valueX100 < 100) return 5;
  if (valueX100 < 1000) return 10;
  return 100;
}

export function niceValueX100(valueX100: number): number {
  const step = niceStepX100(valueX100);
  return Math.max(step, Math.round(valueX100 / step) * step);
}

/** Черновик × k, полоса 5–6 × m, с красивым округлением; порядок по полосам и по ярусам сохраняется нестрого. */
export function niceTable(k: number, low = 1): number[][] {
  return DRAFT_PAYTABLE_X100.map((row) => row.map((value, band) => niceValueX100(value * k * bandFactor(band, low))));
}

export function maxCellX100(table: readonly (readonly number[])[]): number {
  return Math.max(...table.flat());
}

/** Выплата не убывает по полосам и по ярусам: крупный кластер и старший символ не платят меньше. */
export function isMonotone(table: readonly (readonly number[])[]): boolean {
  return table.every((row, symbol) =>
    row.every((value, band) => (band === 0 || value >= (row[band - 1] ?? 0)) && (symbol === 0 || value >= (table[symbol - 1]?.[band] ?? 0))),
  );
}
