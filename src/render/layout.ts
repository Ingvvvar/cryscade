// Раскладки §9 — данные без Pixi. Холст дизайна вписывается (contain) в безопасную область вьюпорта и
// центрируется; фон занимает весь вьюпорт (cover). Ориентация — по пропорции безопасной области.
// Зоны — прямоугольники в единицах дизайна: по ним ставятся сетка, рамка, счётчик и панель React.

import { GRID_SIDE } from '../core/model/grid.ts';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Плашка числа множителя на экране: сама плашка и её содержимое — замок и число (для зонда). */
export interface ChipRect {
  readonly plaque: Rect;
  readonly content: Rect;
}

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** Вьюпорт в CSS-пикселях и отступы безопасной зоны — env(safe-area-inset-*). */
export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly insets: Insets;
}

type Orientation = 'portrait' | 'landscape';

/** winLabel — подпись в React, winValue — число выигрыша в Pixi (§11: счётчик крутится в Pixi). */
export type ZoneName =
  | 'top'
  | 'feature'
  | 'frame'
  | 'grid'
  | 'winLabel'
  | 'winValue'
  | 'balance'
  | 'betDown'
  | 'betValue'
  | 'betUp'
  | 'spin'
  | 'toggles';

export interface Design {
  readonly width: number;
  readonly height: number;
  readonly zones: Readonly<Record<ZoneName, Rect>>;
}

/** Клетка сетки в единицах дизайна (§9: не меньше 84). */
export const CELL = 84;
/** Огранённый край рамки вокруг сетки. */
export const FRAME_BORDER = 24;

const GRID = GRID_SIDE * CELL;
const FRAME = GRID + 2 * FRAME_BORDER;

function framed(x: number, y: number): Pick<Record<ZoneName, Rect>, 'frame' | 'grid'> {
  return {
    frame: { x, y, width: FRAME, height: FRAME },
    grid: { x: x + FRAME_BORDER, y: y + FRAME_BORDER, width: GRID, height: GRID },
  };
}

export const DESIGNS: Readonly<Record<Orientation, Design>> = {
  portrait: {
    width: 720,
    height: 1280,
    zones: {
      top: { x: 0, y: 0, width: 720, height: 88 },
      feature: { x: 0, y: 88, width: 720, height: 64 },
      ...framed(42, 160),
      winLabel: { x: 40, y: 812, width: 300, height: 88 },
      winValue: { x: 360, y: 812, width: 320, height: 88 },
      balance: { x: 0, y: 900, width: 720, height: 56 },
      betDown: { x: 60, y: 1000, width: 140, height: 104 },
      spin: { x: 250, y: 968, width: 220, height: 168 },
      betUp: { x: 520, y: 1000, width: 140, height: 104 },
      betValue: { x: 230, y: 1140, width: 260, height: 40 },
      toggles: { x: 40, y: 1188, width: 640, height: 76 },
    },
  },
  landscape: {
    width: 1280,
    height: 720,
    zones: {
      top: { x: 0, y: 0, width: 1280, height: 64 },
      feature: { x: 24, y: 88, width: 244, height: 200 },
      balance: { x: 24, y: 632, width: 244, height: 64 },
      ...framed(292, 72),
      winLabel: { x: 952, y: 96, width: 304, height: 48 },
      winValue: { x: 952, y: 144, width: 304, height: 88 },
      spin: { x: 1024, y: 256, width: 160, height: 160 },
      betDown: { x: 952, y: 440, width: 80, height: 72 },
      betValue: { x: 1040, y: 440, width: 136, height: 72 },
      betUp: { x: 1176, y: 440, width: 80, height: 72 },
      toggles: { x: 952, y: 544, width: 304, height: 72 },
    },
  },
};

export interface Layout {
  readonly orientation: Orientation;
  readonly design: Design;
  /** CSS-пикселей на единицу дизайна. */
  readonly scale: number;
  /** Весь вьюпорт — под фон. */
  readonly viewport: Rect;
  /** Вьюпорт без отступов безопасной зоны. */
  readonly safe: Rect;
  /** Холст дизайна на экране, CSS-пиксели. */
  readonly stage: Rect;
}

export function computeLayout(viewport: Viewport): Layout {
  const { insets } = viewport;
  const safe: Rect = {
    x: insets.left,
    y: insets.top,
    width: Math.max(0, viewport.width - insets.left - insets.right),
    height: Math.max(0, viewport.height - insets.top - insets.bottom),
  };
  const orientation: Orientation = safe.width >= safe.height ? 'landscape' : 'portrait';
  const design = DESIGNS[orientation];
  const scale = Math.min(safe.width / design.width, safe.height / design.height);
  const width = design.width * scale;
  const height = design.height * scale;
  return {
    orientation,
    design,
    scale,
    viewport: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    safe,
    stage: { x: safe.x + (safe.width - width) / 2, y: safe.y + (safe.height - height) / 2, width, height },
  };
}

/** Разрешение рендерера не выше 2: атлас выпечен в 2×, а на телефоне с DPR 3 это 2.25 раза меньше пикселей
 *  полноэкранного шейдера — главного расхода кадра. */
export const MAX_RESOLUTION = 2;

export function renderResolution(devicePixelRatio: number): number {
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? Math.min(devicePixelRatio, MAX_RESOLUTION) : 1;
}

/** Прямоугольник дизайна → CSS-пиксели на экране. */
export function toScreen(layout: Layout, rect: Rect): Rect {
  const { stage, scale } = layout;
  return { x: stage.x + rect.x * scale, y: stage.y + rect.y * scale, width: rect.width * scale, height: rect.height * scale };
}

/** Клетка cell = row * 7 + col в единицах дизайна. */
export function cellRect(design: Design, cell: number): Rect {
  const { grid } = design.zones;
  return { x: grid.x + (cell % GRID_SIDE) * CELL, y: grid.y + Math.floor(cell / GRID_SIDE) * CELL, width: CELL, height: CELL };
}
