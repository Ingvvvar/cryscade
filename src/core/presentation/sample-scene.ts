// sampleScene (§8.2): кадр как функция расписания и времени. Снимок группы, в которой лежит t, плюс сегменты этой
// группы до t — без памяти о прошлых кадрах, поэтому пропуск, пауза и восстановление — просто другое t.
// Горячий путь кадра: ни одной аллокации. V8 упаковывает дробное число в кучу, когда оно идёт аргументом или
// возвратом в функцию, которую не встроил, — поэтому времена расписания и t здесь целые миллисекунды, ход сегмента
// считается внутри каждой функции, а высоты падения пишутся в буфер SceneState, а не возвращаются.

import { CELL_COUNT, GRID_SIDE } from '../model/grid.ts';
import { fillColumnHeights } from './fall.ts';
import { CLEAR_DROP, type Schedule, type Segment } from './schedule.ts';
import { EMPTY_CELL, PLAQUE, type SceneState } from './scene-state.ts';

/** Индекс группы, в которой лежит t: последняя, чей старт не позже t. */
export function groupAt(schedule: Schedule, tMs: number): number {
  const groups = schedule.groups;
  let low = 0;
  let high = groups.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((groups[middle]?.startMs ?? 0) <= tMs) low = middle;
    else high = middle - 1;
  }
  return low;
}

function resetMotion(out: SceneState): void {
  out.offsetY.fill(0);
  out.alpha.fill(1);
  out.scale.fill(1);
  out.highlight.fill(0);
  out.explode.fill(-1);
  out.spotPop.fill(-1);
  out.contourStep = -1;
  out.contourAlpha = 0;
  out.plaque = PLAQUE.none;
  out.plaqueAlpha = 0;
  out.plaqueValue = 0;
  out.bigWinLevel = 0;
  out.bigWinProgress = 0;
  out.bigWinMinor = 0;
  out.segment = -1;
  out.settled = true;
}

/**
 * Кадр расписания в момент tMs: целые миллисекунды (дробное округляется); до нуля — как в ноль, после конца — конец:
 * все сегменты завершены.
 */
export function sampleScene(schedule: Schedule, tMs: number, out: SceneState): void {
  const t = Math.max(Math.round(tMs), 0);
  resetMotion(out);
  const index = groupAt(schedule, t);
  const group = schedule.groups[index];
  if (group === undefined) {
    out.symbol.fill(EMPTY_CELL);
    out.spotLevel.fill(0);
    out.counterMinor = 0;
    out.freeSpinsLeft = -1;
    out.freeSpinIndex = 0;
    out.group = 0;
    return;
  }
  out.group = index;
  out.symbol.set(group.start.grid);
  out.spotLevel.set(group.start.spots);
  out.counterMinor = group.start.counterMinor;
  out.freeSpinsLeft = group.start.freeSpinsLeft;
  out.freeSpinIndex = group.start.freeSpinIndex;
  // Сегменты группы идут подряд: первый, что начинается позже t, и все за ним ещё не начались.
  for (let s = group.firstSegment; s < group.segmentEnd; s++) {
    const segment = schedule.segments[s];
    if (segment === undefined || segment.startMs > t) break;
    if (t < segment.endMs) out.segment = s;
    apply(schedule, segment, t, out);
  }
}

function apply(schedule: Schedule, segment: Segment, t: number, out: SceneState): void {
  switch (segment.kind) {
    case 'clear':
      clear(segment, t, out);
      break;
    case 'fall':
      fall(schedule, segment, t, out);
      break;
    case 'highlight':
      highlight(schedule, segment, t, out);
      break;
    case 'explode':
      explode(schedule, segment, t, out);
      break;
    case 'spots':
      spots(schedule, segment, t, out);
      break;
    case 'refill':
      refill(schedule, segment, t, out);
      break;
    case 'cap':
      cap(schedule, segment, t, out);
      break;
    case 'tally':
      tally(schedule, segment, t, out);
      break;
    case 'scatters':
      scatters(schedule, segment, t, out);
      break;
    case 'plaqueIn':
    case 'plaqueShow':
    case 'plaqueOut':
      plaque(schedule, segment, t, out);
      break;
    case 'celebrate':
      celebrate(schedule, segment, t, out);
      break;
    case 'pause':
      break;
  }
}

/** Прежняя сетка уходит вниз и гаснет. К концу сброса её место занимает падение новой — оно следом, в той же группе. */
function clear(segment: Segment, t: number, out: SceneState): void {
  if (t >= segment.endMs) return;
  const p = (t - segment.startMs) / (segment.endMs - segment.startMs);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    if (out.symbol[cell] === EMPTY_CELL) continue;
    out.alpha[cell] = 1 - p;
    out.offsetY[cell] = -CLEAR_DROP * p * p;
    out.settled = false;
  }
}

/** Новая сетка падает колонками с высоты сетки (§8.3, fall.ts). */
function fall(schedule: Schedule, segment: Segment, t: number, out: SceneState): void {
  const fill = schedule.fills[segment.data];
  if (fill === undefined) return;
  out.symbol.set(fill);
  if (t >= segment.endMs) return;
  fillColumnHeights(schedule.profile, t - segment.startMs, out.columnFall);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    const height = GRID_SIDE * (out.columnFall[cell % GRID_SIDE] ?? 0);
    out.offsetY[cell] = height;
    if (height !== 0) out.settled = false;
  }
}

function highlight(schedule: Schedule, segment: Segment, t: number, out: SceneState): void {
  const step = schedule.steps[segment.data];
  if (step === undefined || t >= segment.endMs) return;
  const p = (t - segment.startMs) / (segment.endMs - segment.startMs);
  // Быстрый подъём и ровное горение — без пульса: вспышка одна (WCAG 2.3.1).
  const rise = Math.min(1, p / 0.2);
  out.contourStep = segment.data;
  out.contourAlpha = rise;
  if (!segment.celebrate) return;
  for (let cell = 0; cell < CELL_COUNT; cell++) if (step.won[cell] === 1) out.highlight[cell] = rise;
}

/** Выигравшие символы лопаются: растут и гаснут, рендер ведёт осколки по ходу взрыва; к концу клетки пусты. */
function explode(schedule: Schedule, segment: Segment, t: number, out: SceneState): void {
  const step = schedule.steps[segment.data];
  if (step === undefined) return;
  const done = t >= segment.endMs;
  const p = done ? 1 : (t - segment.startMs) / (segment.endMs - segment.startMs);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    if (step.exploded[cell] !== 1) continue;
    if (done) {
      out.symbol[cell] = EMPTY_CELL;
      continue;
    }
    out.explode[cell] = p;
    out.alpha[cell] = 1 - p;
    out.scale[cell] = 1 + 0.3 * p;
    out.settled = false;
  }
  if (!done) {
    out.contourStep = segment.data;
    out.contourAlpha = 1 - p;
  }
}

function spots(schedule: Schedule, segment: Segment, t: number, out: SceneState): void {
  const step = schedule.steps[segment.data];
  if (step === undefined) return;
  const done = t >= segment.endMs;
  const p = done ? 1 : (t - segment.startMs) / (segment.endMs - segment.startMs);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    const level = step.spotAfter[cell] ?? -1;
    if (level < 0) continue;
    out.spotLevel[cell] = level;
    if (!done) {
      out.spotPop[cell] = p;
      out.settled = false;
    }
  }
}

/** Сдвинутые символы падают на своё место, новые — стопкой из-над сетки; колонки — с задержкой. */
function refill(schedule: Schedule, segment: Segment, t: number, out: SceneState): void {
  const step = schedule.steps[segment.data];
  if (step === undefined) return;
  out.symbol.set(step.after);
  if (t >= segment.endMs) return;
  fillColumnHeights(schedule.profile, t - segment.startMs, out.columnFall);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    const from = step.fallFrom[cell] ?? 0;
    if (from === 0) continue;
    const height = from * (out.columnFall[cell % GRID_SIDE] ?? 0);
    out.offsetY[cell] = height;
    if (height !== 0) out.settled = false;
  }
}

/**
 * Плашка капа: появление, показ, уход — по четверти, половине и четверти сегмента. С начала капа фриспинов нет:
 * несыгранные сгорели — счётчик и признаки фичи уходят до конца раунда.
 */
function cap(schedule: Schedule, segment: Segment, t: number, out: SceneState): void {
  out.freeSpinsLeft = -1;
  const item = schedule.plaques[segment.data];
  if (item === undefined || t >= segment.endMs) return;
  const p = (t - segment.startMs) / (segment.endMs - segment.startMs);
  out.plaque = item.kind;
  out.plaqueValue = item.value;
  out.plaqueAlpha = Math.min(1, p / 0.25, (1 - p) / 0.25);
}

/** Подсчёт выигрыша спина: целые единицы, монотонно, к концу — ровно итог. */
function tally(schedule: Schedule, segment: Segment, t: number, out: SceneState): void {
  const range = schedule.tallies[segment.data];
  if (range === undefined) return;
  if (t >= segment.endMs) {
    out.counterMinor = range.to;
    return;
  }
  const rest = 1 - (t - segment.startMs) / (segment.endMs - segment.startMs);
  out.counterMinor = range.from + Math.floor((range.to - range.from) * (1 - rest * rest * rest));
}

function scatters(schedule: Schedule, segment: Segment, t: number, out: SceneState): void {
  const set = schedule.scatterSets[segment.data];
  if (set === undefined || t >= segment.endMs || !segment.celebrate) return;
  const rise = Math.min(1, (t - segment.startMs) / (segment.endMs - segment.startMs) / 0.2);
  for (let cell = 0; cell < CELL_COUNT; cell++) if (set[cell] === 1) out.highlight[cell] = rise;
}

/**
 * Плашка фичи: появление, показ, уход. На конце появления часы ждут игрока (featureIntro): плашку показывает уход с
 * ходом ноль — он начинается ровно там.
 */
function plaque(schedule: Schedule, segment: Segment, t: number, out: SceneState): void {
  const item = schedule.plaques[segment.data];
  if (item === undefined || t >= segment.endMs) return;
  const p = (t - segment.startMs) / (segment.endMs - segment.startMs);
  out.plaque = item.kind;
  out.plaqueValue = item.value;
  out.plaqueAlpha = segment.kind === 'plaqueIn' ? p : segment.kind === 'plaqueShow' ? 1 : 1 - p;
}

function celebrate(schedule: Schedule, segment: Segment, t: number, out: SceneState): void {
  if (t >= segment.endMs) return;
  const p = (t - segment.startMs) / (segment.endMs - segment.startMs);
  const rest = 1 - Math.min(1, p / 0.7);
  out.bigWinLevel = schedule.bigWinLevel;
  out.bigWinProgress = p;
  out.bigWinMinor = Math.floor(schedule.totalMinor * (1 - rest * rest * rest));
}
