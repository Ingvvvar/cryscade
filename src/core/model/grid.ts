// Сетка §4.1: клетки нумеруются по строкам сверху вниз, cell = row * GRID_SIDE + col.

export const GRID_SIDE = 7;

export const CELL_COUNT = 49;

/**
 * Уровень точки в кодировке §4.7: 0 — нет, 1 — отметка, k от 2 до 8 — множитель ×2^(k−1).
 * Верхний уровень 8 — ×128.
 */
export const SPOT_MAX_LEVEL = 8;
