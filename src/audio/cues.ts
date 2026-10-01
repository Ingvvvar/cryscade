// Сигналы звука раунда (§12, решение 2 фазы 8): из расписания показа — один раз на раунд, в типизированные массивы по
// времени. Событие — начало сегмента (у приземления — касание колонки по профилю падения). Директор идёт по таблице
// курсором: в кадре ни объекта, ни строки. Строгий пресет: подсчёт выигрыша ≤ ставки не празднует — и сигнала нет.

import { GRID_SIDE } from '../core/model/grid.ts';
import { PLAQUE, columnStartMs, type Schedule, type Segment } from '../core/presentation/index.ts';

/** Виды сигналов; число — и порядок важности: при пропуске звучит один, старший из пропущенных. */
export const CUE = {
  land: 0,
  core: 1,
  spot: 2,
  cluster: 3,
  win: 4,
  cap: 5,
  retrigger: 6,
  featureStart: 7,
  bigWin: 8,
} as const;

export type CueKind = (typeof CUE)[keyof typeof CUE];

/** Под какими сигналами приседает фон (§12): выигрыш, фича, большой выигрыш — не частые события. */
export function ducks(kind: CueKind): boolean {
  return kind >= CUE.win;
}

/** Таблица раунда: сигнал i — kinds[i] в times[i] мс, value[i] — высота, уровень или число; hold[i] — сколько держать приседание. */
export interface CueTable {
  readonly length: number;
  readonly times: Float64Array;
  readonly kinds: Uint8Array;
  readonly values: Int16Array;
  readonly holds: Float64Array;
  /** Старт фичи: с него фон теплее до конца раунда; нет фичи — +∞. */
  readonly warmFrom: number;
  readonly durationMs: number;
}

interface Draft {
  readonly time: number;
  readonly kind: CueKind;
  readonly value: number;
  readonly hold: number;
}

function landings(schedule: Schedule, segment: Segment, falling: (column: number) => boolean, out: Draft[]): void {
  for (let column = 0; column < GRID_SIDE; column++) {
    if (!falling(column)) continue;
    const time = segment.startMs + columnStartMs(schedule.profile, column) + schedule.profile.touchMs;
    if (time < segment.endMs) out.push({ time, kind: CUE.land, value: column, hold: 0 });
  }
}

/** Колонки, где досыпка что-то роняет. */
function fallingColumns(fallFrom: Int8Array): (column: number) => boolean {
  return (column) => {
    for (let cell = column; cell < fallFrom.length; cell += GRID_SIDE) if ((fallFrom[cell] ?? 0) !== 0) return true;
    return false;
  };
}

function count(cells: Uint8Array): number {
  let total = 0;
  for (const cell of cells) total += cell;
  return total;
}

/** Наибольший новый уровень точки шага; 0 — точки не поднялись до множителя (уровень 2 и выше — ×2…). */
function topSpot(levels: Int16Array): number {
  let top = 0;
  for (const level of levels) if (level > top) top = level;
  return top >= 2 ? top : 0;
}

export function buildCues(schedule: Schedule): CueTable {
  const drafts: Draft[] = [];
  let cascade = 0;
  let warmFrom = Number.POSITIVE_INFINITY;
  for (const segment of schedule.segments) {
    const hold = segment.endMs - segment.startMs;
    switch (segment.kind) {
      case 'fall':
        cascade = 0;
        landings(schedule, segment, () => true, drafts);
        break;
      case 'refill': {
        const step = schedule.steps[segment.data];
        if (step !== undefined) landings(schedule, segment, fallingColumns(step.fallFrom), drafts);
        break;
      }
      case 'highlight':
        drafts.push({ time: segment.startMs, kind: CUE.cluster, value: cascade, hold: 0 });
        cascade += 1;
        break;
      case 'spots': {
        const step = schedule.steps[segment.data];
        const level = step === undefined ? 0 : topSpot(step.spotAfter);
        if (level > 0) drafts.push({ time: segment.startMs, kind: CUE.spot, value: level, hold: 0 });
        break;
      }
      case 'scatters': {
        const set = schedule.scatterSets[segment.data];
        drafts.push({ time: segment.startMs, kind: CUE.core, value: set === undefined ? 0 : count(set), hold: 0 });
        break;
      }
      case 'plaqueIn': {
        const plaque = schedule.plaques[segment.data];
        if (plaque?.kind === PLAQUE.intro) {
          drafts.push({ time: segment.startMs, kind: CUE.featureStart, value: plaque.value, hold });
          warmFrom = Math.min(warmFrom, segment.startMs);
        } else if (plaque?.kind === PLAQUE.retrigger) {
          drafts.push({ time: segment.startMs, kind: CUE.retrigger, value: plaque.value, hold });
        }
        break;
      }
      case 'cap':
        drafts.push({ time: segment.startMs, kind: CUE.cap, value: 0, hold });
        break;
      case 'tally':
        if (segment.celebrate) drafts.push({ time: segment.startMs, kind: CUE.win, value: 0, hold });
        break;
      case 'celebrate':
        drafts.push({ time: segment.startMs, kind: CUE.bigWin, value: schedule.bigWinLevel, hold });
        break;
      default:
        break;
    }
  }
  // Касания колонок досыпки идут внутри сегмента — порядок по времени, при равенстве — порядок появления.
  const order = drafts.map((_, index) => index).sort((a, b) => (drafts[a]?.time ?? 0) - (drafts[b]?.time ?? 0) || a - b);
  const table = {
    length: drafts.length,
    times: new Float64Array(drafts.length),
    kinds: new Uint8Array(drafts.length),
    values: new Int16Array(drafts.length),
    holds: new Float64Array(drafts.length),
    warmFrom,
    durationMs: schedule.durationMs,
  };
  order.forEach((from, to) => {
    const draft = drafts[from];
    if (draft === undefined) return;
    table.times[to] = draft.time;
    table.kinds[to] = draft.kind;
    table.values[to] = draft.value;
    table.holds[to] = draft.hold;
  });
  return table;
}
