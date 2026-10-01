// Расписание раунда (§8.2): неизменный план показа по событиям раунда. Входы — события, ставка, выигрыш и прежняя
// сетка; параметры — скорость, флаги пресета, reduced motion. Скорость и флаги меняют длительности, но не состав групп:
// группа — шаг событий (заполнение, шаг каскада, вход в фичу, ретриггер, большой выигрыш), и контрольная точка
// восстановления — её индекс. Всё тяжёлое — снимки групп, шаги каскада, контуры — считается здесь, один раз на раунд;
// sampleScene потом только читает.

import type { PresetFlags } from '../jurisdiction.ts';
import type { RoundEvent, WinCluster } from '../model/events.ts';
import { CELL_COUNT, GRID_SIDE } from '../model/grid.ts';
import { winMinor } from '../money.ts';
import { clusterContour, type ContourRing } from './contour.ts';
import { FALL, gridSettleMs, type FallProfile } from './fall.ts';
import { EMPTY_CELL, PLAQUE, type PlaqueKind } from './scene-state.ts';
import { TIMINGS, bigWinLevel, celebrateMs, counterMs, type SegmentTimings, type Speed } from './timings.ts';

export type GroupKind = 'fill' | 'cascade' | 'feature' | 'retrigger' | 'bigWin';

export type SegmentKind =
  | 'clear'
  | 'fall'
  | 'highlight'
  | 'explode'
  | 'spots'
  | 'refill'
  | 'cap'
  | 'tally'
  | 'scatters'
  | 'plaqueIn'
  | 'plaqueShow'
  | 'plaqueOut'
  | 'celebrate'
  | 'pause';

export interface Segment {
  readonly kind: SegmentKind;
  readonly group: number;
  readonly startMs: number;
  readonly endMs: number;
  /** Индекс данных: fall — в fills, шаги каскада — в steps, tally — в tallies, ядра — в scatterSets, плашки — в plaques. */
  readonly data: number;
  /** Празднует выигрыш: свечение, подсчёт, большой выигрыш. В строгом пресете при выигрыше ≤ ставки таких нет. */
  readonly celebrate: boolean;
  /** Вспышка на старте сегмента — счёт WCAG 2.3.1. */
  readonly flash: boolean;
}

/** Что на поле на старте группы. */
export interface GroupStart {
  readonly grid: Int8Array;
  readonly spots: Uint8Array;
  readonly counterMinor: number;
  readonly freeSpinsLeft: number;
  readonly freeSpinIndex: number;
}

export interface Group {
  readonly kind: GroupKind;
  readonly startMs: number;
  readonly endMs: number;
  /**
   * Единица пропуска (§8.2): спин — основной или фриспин, от своего заполнения до следующего, с плашками фичи и
   * ретриггера, которые он открыл, — или празднование большого выигрыша. Счёт тапов живёт в пределах единицы.
   */
  readonly unit: number;
  readonly firstSegment: number;
  /** Индекс сегмента после последнего сегмента группы. */
  readonly segmentEnd: number;
  /** События группы: [fromEvent, toEvent). */
  readonly fromEvent: number;
  readonly toEvent: number;
  readonly start: GroupStart;
}

export interface StepCluster {
  readonly symbol: number;
  readonly cells: readonly number[];
  readonly contour: readonly ContourRing[];
}

/** Шаг каскада: кластеры, взрыв, точки, досыпка — всё, что sampleScene нужно, уже в буферах. */
export interface CascadeStep {
  readonly clusters: readonly StepCluster[];
  /** 1 — клетка в кластере шага. */
  readonly won: Uint8Array;
  /** 1 — клетка взорвана; на шаге капа взрыва нет. */
  readonly exploded: Uint8Array;
  /** Новый уровень точки клетки; −1 — не менялся. */
  readonly spotAfter: Int16Array;
  /** Сетка после досыпки и высота, с которой символ клетки падает, клеток (0 — не двигался). */
  readonly after: Int8Array;
  readonly fallFrom: Int8Array;
}

export interface Tally {
  readonly from: number;
  readonly to: number;
}

export interface Plaque {
  readonly kind: PlaqueKind;
  readonly value: number;
}

export interface Schedule {
  readonly durationMs: number;
  readonly groups: readonly Group[];
  readonly segments: readonly Segment[];
  readonly fills: readonly Int8Array[];
  readonly steps: readonly CascadeStep[];
  readonly tallies: readonly Tally[];
  readonly scatterSets: readonly Uint8Array[];
  readonly plaques: readonly Plaque[];
  /** Точки удержания featureIntro: часы показа ждут здесь тапа или пробела. Расписание от удержания не меняется. */
  readonly holds: readonly number[];
  /** Конец каждой единицы пропуска, мс: начало следующей; последняя кончается с раундом. */
  readonly unitEnds: readonly number[];
  readonly profile: FallProfile;
  /** Итоговая сетка: что лежит на поле в конце показа. */
  readonly finalGrid: Int8Array;
  readonly totalMinor: number;
  readonly bigWinLevel: number;
  /** Празднует ли раунд вообще: строгий пресет не празднует выигрыш ≤ ставки. */
  readonly celebrates: boolean;
  /** Раунд собран под reduced motion (§8.4): падение без отскока, частиц и всплесков нет — до конца раунда. */
  readonly reducedMotion: boolean;
  /** Скорость, с которой раунд собран: турбо, переключённое посреди раунда, ждёт следующего. */
  readonly speed: Speed;
}

export interface ScheduleRound {
  readonly events: readonly RoundEvent[];
  readonly betMinor: number;
  /** Выигрыш раунда от сервера — итог счётчика. */
  readonly winMinor: number;
  /** Сетка на поле до раунда; null — неизвестна (раунд восстановлен после перезагрузки). */
  readonly previousGrid: readonly number[] | null;
}

export interface ScheduleOptions {
  readonly speed: Speed;
  readonly preset: Pick<PresetFlags, 'minSpinCycleMs' | 'celebrateSmallWins'>;
  readonly reducedMotion: boolean;
}

/** Смещение прежней сетки вниз при сбросе, клеток. */
export const CLEAR_DROP = 0.5;

interface SegmentDraft {
  readonly kind: SegmentKind;
  readonly durationMs: number;
  readonly data: number;
  readonly celebrate: boolean;
  readonly flash: boolean;
}

interface GroupDraft {
  readonly kind: GroupKind;
  readonly fromEvent: number;
  toEvent: number;
  readonly start: GroupStart;
  readonly segments: SegmentDraft[];
  /** Индекс сегмента, после которого часы ждут игрока. */
  hold: number;
}

/** Builder расписания: события по порядку — в черновики групп, потом времена подряд. */
class ScheduleBuilder {
  readonly #options: ScheduleOptions;
  readonly #timings: SegmentTimings;
  readonly #profile: FallProfile;
  readonly #fillMs: number;
  readonly #round: ScheduleRound;
  readonly #celebrates: boolean;
  readonly #groups: GroupDraft[] = [];
  readonly #fills: Int8Array[] = [];
  readonly #steps: CascadeStep[] = [];
  readonly #tallies: Tally[] = [];
  readonly #scatterSets: Uint8Array[] = [];
  readonly #plaques: Plaque[] = [];
  readonly #grid = new Int8Array(CELL_COUNT).fill(EMPTY_CELL);
  readonly #spots = new Uint8Array(CELL_COUNT);
  #counter = 0;
  #freeSpinsLeft = -1;
  #freeSpinIndex = 0;
  /** Сумма выплат раунда по кластерам, сотые ставки. */
  #payX100 = 0;
  /** Выплаты текущего спина: есть — в конце спина подсчёт. */
  #spinPay = 0;
  #capped = false;

  constructor(round: ScheduleRound, options: ScheduleOptions) {
    this.#round = round;
    this.#options = options;
    this.#timings = TIMINGS[options.speed];
    this.#profile = options.reducedMotion ? FALL.reduced : FALL[options.speed];
    this.#fillMs = gridSettleMs(this.#profile);
    const endEvent = round.events.at(-1);
    const totalX100 = endEvent?.t === 'end' ? endEvent.payX100 : 0;
    this.#celebrates = options.preset.celebrateSmallWins || totalX100 > 100;
    if (round.previousGrid !== null) {
      for (let cell = 0; cell < CELL_COUNT; cell++) this.#grid[cell] = round.previousGrid[cell] ?? EMPTY_CELL;
    }
  }

  build(): Schedule {
    const { events } = this.#round;
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (event === undefined) continue;
      this.#event(event, index, events[index + 1]);
    }
    return this.#timeline();
  }

  #event(event: RoundEvent, index: number, next: RoundEvent | undefined): void {
    switch (event.t) {
      case 'fill':
        this.#fill(event.grid, index);
        break;
      case 'win':
        this.#win(event.clusters, index);
        break;
      case 'explode':
        this.#explode(event.cells, index);
        break;
      case 'spots':
        this.#spotsOf(event.cells, event.levels, index);
        break;
      case 'refill':
        this.#refill(event.moves, event.drops, index);
        break;
      case 'cap':
        this.#cap(index);
        break;
      case 'scatters':
        this.#closeSpin();
        this.#scatters(event.cells, index, next?.t === 'fsRetrigger' ? 'retrigger' : 'feature');
        break;
      case 'fsStart':
        this.#fsStart(event.spins, index);
        break;
      case 'fsRetrigger':
        this.#retrigger(event.add, index);
        break;
      case 'fsSpin':
        this.#closeSpin();
        this.#freeSpinIndex = event.index;
        this.#freeSpinsLeft = event.left;
        break;
      case 'end':
        this.#closeSpin();
        this.#end(event.payX100, index);
        break;
    }
  }

  #start(): GroupStart {
    return {
      grid: Int8Array.from(this.#grid),
      spots: Uint8Array.from(this.#spots),
      counterMinor: this.#counter,
      freeSpinsLeft: this.#freeSpinsLeft,
      freeSpinIndex: this.#freeSpinIndex,
    };
  }

  #open(kind: GroupKind, fromEvent: number): GroupDraft {
    const group: GroupDraft = { kind, fromEvent, toEvent: fromEvent + 1, start: this.#start(), segments: [], hold: -1 };
    this.#groups.push(group);
    return group;
  }

  #current(index: number): GroupDraft {
    const group = this.#groups.at(-1);
    if (group === undefined) throw new Error('расписание: событие до fill');
    group.toEvent = index + 1;
    return group;
  }

  /** Длительности — целые миллисекунды: кадр читает расписание целыми числами (sample-scene.ts). */
  #add(group: GroupDraft, kind: SegmentKind, durationMs: number, data = -1, celebrate = false, flash = false): void {
    group.segments.push({ kind, durationMs: Math.round(durationMs), data, celebrate, flash });
  }

  /** Точки во фриспинах живут между заполнениями; основной спин — первый в раунде, его поле точек и так пустое. */
  #fill(grid: readonly number[], index: number): void {
    const group = this.#open('fill', index);
    const fill = new Int8Array(CELL_COUNT);
    for (let cell = 0; cell < CELL_COUNT; cell++) fill[cell] = grid[cell] ?? EMPTY_CELL;
    this.#fills.push(fill);
    this.#add(group, 'clear', this.#timings.clearMs);
    this.#add(group, 'fall', this.#fillMs, this.#fills.length - 1);
    this.#grid.set(fill);
    this.#spinPay = 0;
  }

  #win(clusters: readonly WinCluster[], index: number): void {
    const group = this.#open('cascade', index);
    const won = new Uint8Array(CELL_COUNT);
    const stepClusters: StepCluster[] = clusters.map((cluster) => {
      for (const cell of cluster.cells) won[cell] = 1;
      return { symbol: cluster.symbol, cells: [...cluster.cells], contour: clusterContour(cluster.cells) };
    });
    for (const cluster of clusters) this.#spinPay += cluster.payX100;
    this.#payX100 += clusters.reduce((sum, cluster) => sum + cluster.payX100, 0);
    this.#steps.push({
      clusters: stepClusters,
      won,
      exploded: new Uint8Array(CELL_COUNT),
      spotAfter: new Int16Array(CELL_COUNT).fill(-1),
      after: Int8Array.from(this.#grid),
      fallFrom: new Int8Array(CELL_COUNT),
    });
    // Без празднования подсветка — только контур, без свечения: и не вспышка.
    this.#add(group, 'highlight', this.#timings.highlightMs, this.#steps.length - 1, this.#celebrates, this.#celebrates);
  }

  #step(): CascadeStep {
    const step = this.#steps.at(-1);
    if (step === undefined) throw new Error('расписание: шаг каскада без win');
    return step;
  }

  #explode(cells: readonly number[], index: number): void {
    const group = this.#current(index);
    const step = this.#step();
    for (const cell of cells) {
      step.exploded[cell] = 1;
      this.#grid[cell] = EMPTY_CELL;
    }
    this.#add(group, 'explode', this.#timings.explodeMs, this.#steps.length - 1, false, true);
  }

  #spotsOf(cells: readonly number[], levels: readonly number[], index: number): void {
    const group = this.#current(index);
    const step = this.#step();
    cells.forEach((cell, k) => {
      const level = levels[k] ?? 0;
      step.spotAfter[cell] = level;
      this.#spots[cell] = level;
    });
    this.#add(group, 'spots', cells.length > 0 ? this.#timings.spotsMs : 0, this.#steps.length - 1);
  }

  #refill(moves: readonly (readonly [number, number])[], drops: readonly { cell: number; symbol: number }[], index: number): void {
    const group = this.#current(index);
    const step = this.#step();
    for (const [from, to] of moves) {
      this.#grid[to] = this.#grid[from] ?? EMPTY_CELL;
      this.#grid[from] = EMPTY_CELL;
      step.fallFrom[to] = (to - from) / GRID_SIDE;
    }
    // Досыпка колонки падает стопкой из-над сетки: каждый новый символ — с высоты числа новых в колонке.
    const dropsInColumn = new Uint8Array(GRID_SIDE);
    for (const drop of drops) dropsInColumn[drop.cell % GRID_SIDE] = (dropsInColumn[drop.cell % GRID_SIDE] ?? 0) + 1;
    for (const drop of drops) {
      this.#grid[drop.cell] = drop.symbol;
      step.fallFrom[drop.cell] = dropsInColumn[drop.cell % GRID_SIDE] ?? 0;
    }
    step.after.set(this.#grid);
    this.#add(group, 'refill', this.#fillMs, this.#steps.length - 1);
  }

  /** Кап кончает раунд: несыгранные фриспины сгорают — следующие группы начинаются без фичи. */
  #cap(index: number): void {
    const group = this.#current(index);
    this.#capped = true;
    this.#freeSpinsLeft = -1;
    this.#plaques.push({ kind: PLAQUE.cap, value: 0 });
    const { plaqueInMs, plaqueShowMs, plaqueOutMs } = this.#timings;
    this.#add(group, 'cap', plaqueInMs + plaqueShowMs + plaqueOutMs, this.#plaques.length - 1);
  }

  /** Конец спина: был выигрыш — подсчёт в последней группе каскада, до итога раунда. */
  #closeSpin(): void {
    if (this.#spinPay <= 0) return;
    const group = this.#groups.at(-1);
    if (group === undefined) return;
    const to = Math.min(this.#round.winMinor, winMinor(this.#round.betMinor, this.#payX100));
    this.#tallies.push({ from: this.#counter, to });
    const duration = this.#celebrates ? counterMs(this.#spinPay, this.#options.speed) : 0;
    this.#add(group, 'tally', duration, this.#tallies.length - 1, this.#celebrates);
    this.#counter = to;
    this.#spinPay = 0;
  }

  #scatters(cells: readonly number[], index: number, kind: 'feature' | 'retrigger'): void {
    const group = this.#open(kind, index);
    const set = new Uint8Array(CELL_COUNT);
    for (const cell of cells) set[cell] = 1;
    this.#scatterSets.push(set);
    this.#add(group, 'scatters', this.#timings.highlightMs, this.#scatterSets.length - 1, this.#celebrates, this.#celebrates);
  }

  #fsStart(spins: number, index: number): void {
    const group = this.#current(index);
    this.#spots.fill(0);
    this.#freeSpinsLeft = spins;
    this.#plaques.push({ kind: PLAQUE.intro, value: spins });
    this.#add(group, 'plaqueIn', this.#timings.plaqueInMs, this.#plaques.length - 1);
    group.hold = group.segments.length - 1;
    this.#add(group, 'plaqueOut', this.#timings.plaqueOutMs, this.#plaques.length - 1);
  }

  #retrigger(add: number, index: number): void {
    const group = this.#current(index);
    this.#freeSpinsLeft += add;
    this.#plaques.push({ kind: PLAQUE.retrigger, value: add });
    this.#add(group, 'plaqueIn', this.#timings.plaqueInMs, this.#plaques.length - 1);
    this.#add(group, 'plaqueShow', this.#timings.plaqueShowMs, this.#plaques.length - 1);
    this.#add(group, 'plaqueOut', this.#timings.plaqueOutMs, this.#plaques.length - 1);
  }

  /** end — в группу большого выигрыша, если он есть, иначе — в последнюю группу. */
  #end(payX100: number, index: number): void {
    const level = bigWinLevel(payX100, this.#capped);
    if (level > 0) {
      const group = this.#open('bigWin', index);
      this.#add(group, 'celebrate', celebrateMs(level, this.#options.speed), -1, true, true);
      return;
    }
    const last = this.#groups.at(-1);
    if (last !== undefined) last.toEvent = index + 1;
  }

  #timeline(): Schedule {
    // Строгий пресет: цикл спина не короче минимального — пауза в конце последней группы, состав групп тот же.
    const planned = this.#groups.reduce((sum, group) => sum + group.segments.reduce((part, segment) => part + segment.durationMs, 0), 0);
    const last = this.#groups.at(-1);
    if (last !== undefined && planned < this.#options.preset.minSpinCycleMs) this.#add(last, 'pause', this.#options.preset.minSpinCycleMs - planned);
    const groups: Group[] = [];
    const segments: Segment[] = [];
    const holds: number[] = [];
    const unitEnds: number[] = [];
    let at = 0;
    // Раунд начинается с заполнения (#current бросает на событии до fill): первая группа открывает единицу 0.
    let unit = -1;
    this.#groups.forEach((draft, groupIndex) => {
      const firstSegment = segments.length;
      const startMs = at;
      if (draft.kind === 'fill' || draft.kind === 'bigWin') unit += 1;
      draft.segments.forEach((segment, k) => {
        // Пауза строгого кончается ровно на минимальном цикле: сумма длительностей с плавающей точкой недобрала бы
        // до него (контрпример property — 2499.9999999999995).
        const endMs = segment.kind === 'pause' ? Math.max(at + segment.durationMs, this.#options.preset.minSpinCycleMs) : at + segment.durationMs;
        segments.push({ kind: segment.kind, group: groupIndex, startMs: at, endMs, data: segment.data, celebrate: segment.celebrate, flash: segment.flash });
        at = endMs;
        if (k === draft.hold) holds.push(at);
      });
      groups.push({
        kind: draft.kind,
        startMs,
        endMs: at,
        unit,
        firstSegment,
        segmentEnd: segments.length,
        fromEvent: draft.fromEvent,
        toEvent: draft.toEvent,
        start: draft.start,
      });
      unitEnds[unit] = at;
    });
    const endEvent = this.#round.events.at(-1);
    return {
      durationMs: at,
      groups,
      segments,
      fills: this.#fills,
      steps: this.#steps,
      tallies: this.#tallies,
      scatterSets: this.#scatterSets,
      plaques: this.#plaques,
      holds,
      unitEnds,
      profile: this.#profile,
      finalGrid: Int8Array.from(this.#grid),
      totalMinor: this.#round.winMinor,
      bigWinLevel: endEvent?.t === 'end' ? bigWinLevel(endEvent.payX100, this.#capped) : 0,
      celebrates: this.#celebrates,
      reducedMotion: this.#options.reducedMotion,
      speed: this.#options.speed,
    };
  }
}

/** Расписание раунда по событиям. События — прошедшие гард протокола: иначе ошибка вызывающего. */
export function buildSchedule(round: ScheduleRound, options: ScheduleOptions): Schedule {
  return new ScheduleBuilder(round, options).build();
}
