// Состояние кадра (§8.2): что рендеру поставить на экран в момент t. Буферы выделяются один раз; sampleScene пишет в
// них на каждом кадре без аллокаций. Высоты — в клетках над точкой покоя (рендер умножает на размер клетки).

import { CELL_COUNT, GRID_SIDE } from '../model/grid.ts';

/** Нет символа в клетке. */
export const EMPTY_CELL = -1;

/** Плашка фичи: нет, начало фриспинов, ретриггер, кап. */
export const PLAQUE = { none: 0, intro: 1, retrigger: 2, cap: 3 } as const;
export type PlaqueKind = (typeof PLAQUE)[keyof typeof PLAQUE];

export class SceneState {
  /** Символ клетки или EMPTY_CELL. */
  readonly symbol = new Int8Array(CELL_COUNT);
  /** Высота над точкой покоя, клеток; отрицательная — ниже (прежняя сетка уходит вниз). */
  readonly offsetY = new Float32Array(CELL_COUNT);
  readonly alpha = new Float32Array(CELL_COUNT);
  readonly scale = new Float32Array(CELL_COUNT);
  /** Свечение подсветки выигравшей клетки, 0…1. */
  readonly highlight = new Float32Array(CELL_COUNT);
  /** Взрыв: −1 — нет, 0…1 — ход взрыва (рендер ведёт осколки из пула по нему). */
  readonly explode = new Float32Array(CELL_COUNT);
  /** Уровень точки §4.7: 0 — нет, 1 — отметка, 2…8 — ×2…×128. */
  readonly spotLevel = new Uint8Array(CELL_COUNT);
  /** Всплеск точки, чей уровень только что сменился: −1 — нет, 0…1. */
  readonly spotPop = new Float32Array(CELL_COUNT);
  /** Шаг каскада, чьи контуры видны (индекс в schedule.steps), −1 — контуров нет. */
  contourStep = -1;
  contourAlpha = 0;
  /** Счётчик выигрыша раунда, минимальные единицы. */
  counterMinor = 0;
  /** Фриспины: осталось после текущего; −1 — основная игра. */
  freeSpinsLeft = -1;
  /** Номер текущего фриспина с единицы; 0 — основная игра. */
  freeSpinIndex = 0;
  plaque: PlaqueKind = PLAQUE.none;
  plaqueAlpha = 0;
  /** Число на плашке: фриспинов при начале и ретриггере. */
  plaqueValue = 0;
  /** Большой выигрыш: уровень 0…4, ход празднования 0…1 и его счётчик. */
  bigWinLevel = 0;
  bigWinProgress = 0;
  bigWinMinor = 0;
  /** Группа и сегмент в расписании; сегмент −1 — показ не начат или закончен. */
  group = 0;
  segment = -1;
  /** Все клетки в покое: символ на месте, без взрывов и всплесков. */
  settled = true;
  /** Рабочий буфер кадра: высоты падения колонок в долях высоты старта. */
  readonly columnFall = new Float64Array(GRID_SIDE);

  constructor() {
    this.clear();
  }

  /** Пустое поле в покое. */
  clear(): void {
    this.symbol.fill(EMPTY_CELL);
    this.offsetY.fill(0);
    this.alpha.fill(1);
    this.scale.fill(1);
    this.highlight.fill(0);
    this.explode.fill(-1);
    this.spotLevel.fill(0);
    this.spotPop.fill(-1);
    this.contourStep = -1;
    this.contourAlpha = 0;
    this.counterMinor = 0;
    this.freeSpinsLeft = -1;
    this.freeSpinIndex = 0;
    this.plaque = PLAQUE.none;
    this.plaqueAlpha = 0;
    this.plaqueValue = 0;
    this.bigWinLevel = 0;
    this.bigWinProgress = 0;
    this.bigWinMinor = 0;
    this.group = 0;
    this.segment = -1;
    this.settled = true;
  }
}
