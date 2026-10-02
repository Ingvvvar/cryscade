import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../../src/core/jurisdiction.ts';
import type { RoundEvent } from '../../../src/core/model/events.ts';
import { columnStartMs, fallHeight } from '../../../src/core/presentation/fall.ts';
import { sampleScene } from '../../../src/core/presentation/sample-scene.ts';
import { EMPTY_CELL, PLAQUE, SceneState } from '../../../src/core/presentation/scene-state.ts';
import { CLEAR_DROP, buildSchedule, type Schedule, type ScheduleOptions, type Segment } from '../../../src/core/presentation/schedule.ts';
import { fixtureRound, type FixtureName } from '../../support/fixture-rounds.ts';

// Кадр посреди каждого вида сегмента (§8.2): ход сегмента p — по целым миллисекундам, значения — из формул §8.3–§8.4,
// посчитанных здесь: взрыв — альфа 1 − p и масштаб 1 + 0.3p, подъём подсветки — p / 0.2, плашка капа —
// min(1, p / 0.25, (1 − p) / 0.25), празднование — 1 − (1 − min(1, p / 0.7))³. Буферы SceneState — float32: ожидание
// округляется так же. Ставка — 100: выигрыш = payX100.

const NORMAL: ScheduleOptions = { speed: 'normal', preset: PRESETS.standard, reducedMotion: false };
const STRICT: ScheduleOptions = { speed: 'normal', preset: PRESETS.strict, reducedMotion: false };

function schedule(name: FixtureName, options: ScheduleOptions = NORMAL, previousGrid: readonly number[] | null = null): Schedule {
  const round = fixtureRound(name);
  return buildSchedule({ events: round.events, betMinor: 100, winMinor: round.payX100, previousGrid }, options);
}

function frame(s: Schedule, t: number, out = new SceneState()): SceneState {
  sampleScene(s, t, out);
  return out;
}

/** n-й сегмент вида kind и его индекс в расписании. */
function segment(s: Schedule, kind: Segment['kind'], nth = 0): { readonly index: number; readonly at: (p: number) => number } {
  const found = s.segments.flatMap((item, index) => (item.kind === kind ? [{ item, index }] : []))[nth];
  if (found === undefined) throw new Error(`нет сегмента ${kind}[${String(nth)}]`);
  const { item, index } = found;
  return { index, at: (p) => item.startMs + p * (item.endMs - item.startMs) };
}

/** Буфер кадра: value на клетках набора, иначе background — во float32, как в SceneState. */
function cells(on: Iterable<number>, value: number, background: number): number[] {
  const set = new Set(on);
  return Array.from({ length: 49 }, (_, cell) => Math.fround(set.has(cell) ? value : background));
}

const of = (values: ArrayLike<number>): number[] => Array.from(values);

function eventOf<T extends RoundEvent['t']>(name: FixtureName, t: T, nth = 0): Extract<RoundEvent, { t: T }> {
  const found = fixtureRound(name).events.filter((event): event is Extract<RoundEvent, { t: T }> => event.t === t)[nth];
  if (found === undefined) throw new Error(`нет события ${t}[${String(nth)}] в ${name}`);
  return found;
}

describe('кадр посреди каскада (small-win: кластер 8, 10, 15, 16, 17)', () => {
  const s = schedule('small-win');
  const won = eventOf('small-win', 'win').clusters.flatMap((cluster) => cluster.cells);
  const exploded = eventOf('small-win', 'explode').cells;
  const spots = eventOf('small-win', 'spots');

  it('подсветка на 10 %: подъём 0.5 — контур и свечение выигравших; сегмент — подсветка; взрыв ещё не начался', () => {
    const highlight = segment(s, 'highlight');
    const out = frame(s, highlight.at(0.1));
    expect(won).toStrictEqual([8, 10, 15, 16, 17]);
    expect([out.segment, out.contourStep, out.contourAlpha, out.settled]).toStrictEqual([highlight.index, 0, 0.5, true]);
    expect(of(out.highlight)).toStrictEqual(cells(won, 0.5, 0));
    expect([of(out.alpha), of(out.scale), of(out.explode)]).toStrictEqual([cells([], 0, 1), cells([], 0, 1), cells([], 0, -1)]);
  });

  it('конец подсветки — начало взрыва: свечения нет, взрыв — ход 0, контур — полный', () => {
    const explode = segment(s, 'explode');
    const out = frame(s, explode.at(0));
    expect([out.segment, out.contourStep, out.contourAlpha]).toStrictEqual([explode.index, 0, 1]);
    expect(of(out.highlight)).toStrictEqual(cells([], 0, 0));
    expect(of(out.explode)).toStrictEqual(cells(exploded, 0, -1));
  });

  it('взрыв на середине: клетки кластера — ход 0.5, альфа 0.5, масштаб 1.15; контур гаснет; подсветки уже нет', () => {
    const explode = segment(s, 'explode');
    const out = frame(s, explode.at(0.5));
    expect([out.segment, out.contourStep, out.contourAlpha, out.settled]).toStrictEqual([explode.index, 0, 0.5, false]);
    expect(of(out.explode)).toStrictEqual(cells(exploded, 0.5, -1));
    expect(of(out.alpha)).toStrictEqual(cells(exploded, 0.5, 1));
    expect(of(out.scale)).toStrictEqual(cells(exploded, 1.15, 1));
    expect(of(out.highlight)).toStrictEqual(cells([], 0, 0));
    expect(of(out.spotPop)).toStrictEqual(cells([], 0, -1));
  });

  it('конец взрыва — начало точек: клетки пусты, контура нет; всплеск точек — 0, уровни — после шага', () => {
    const points = segment(s, 'spots');
    const out = frame(s, points.at(0));
    expect([out.segment, out.contourStep, out.contourAlpha, out.settled]).toStrictEqual([points.index, -1, 0, false]);
    expect(exploded.map((cell) => out.symbol[cell])).toStrictEqual(exploded.map(() => EMPTY_CELL));
    expect([of(out.explode), of(out.alpha), of(out.highlight)]).toStrictEqual([cells([], 0, -1), cells([], 0, 1), cells([], 0, 0)]);
    expect(of(out.spotPop)).toStrictEqual(cells(spots.cells, 0, -1));
  });

  it('точки на середине: всплеск 0.5 на клетках шага, уровень 1 — только на них', () => {
    const out = frame(s, segment(s, 'spots').at(0.5));
    expect(spots.levels).toStrictEqual([1, 1, 1, 1, 1]);
    expect(of(out.spotPop)).toStrictEqual(cells(spots.cells, 0.5, -1));
    expect(of(out.spotLevel)).toStrictEqual(Array.from({ length: 49 }, (_, cell) => (spots.cells.includes(cell) ? 1 : 0)));
    expect(out.settled).toBe(false);
  });

  it('конец точек — начало досыпки: всплеска нет, уровни на месте; досыпка — в движении', () => {
    const refill = segment(s, 'refill');
    const out = frame(s, refill.at(0));
    expect([out.segment, out.settled]).toStrictEqual([refill.index, false]);
    expect(of(out.spotPop)).toStrictEqual(cells([], 0, -1));
    expect(spots.cells.map((cell) => out.spotLevel[cell])).toStrictEqual([1, 1, 1, 1, 1]);
  });

  it('досыпка: через миг после старта — всё в движении; на 427 мс — высоты колонок × пройденные ряды', () => {
    const refill = segment(s, 'refill');
    expect(frame(s, refill.at(0) + 1).settled).toBe(false);
    const local = 427;
    const out = frame(s, refill.at(0) + local);
    const fallFrom = s.steps[0]?.fallFrom ?? new Int8Array(49);
    // Сдвинутые 1 → 15, 9 → 16, 2 → 9, 3 → 17 и новые 1, 2, 3, 8, 10 — колонки 1, 2, 3.
    expect(Array.from(fallFrom, (from, cell) => (from === 0 ? -1 : cell)).filter((cell) => cell >= 0)).toStrictEqual([1, 2, 3, 8, 9, 10, 15, 16, 17]);
    const height = (cell: number): number => (fallFrom[cell] ?? 0) * fallHeight(s.profile, 1, local - columnStartMs(s.profile, cell % 7));
    expect(of(out.offsetY)).toStrictEqual(Array.from({ length: 49 }, (_, cell) => Math.fround(height(cell))));
    expect(out.settled).toBe(false);
  });

  it('досыпка после покоя последней сдвинутой колонки (3) и до конца сегмента — покой', () => {
    const refill = segment(s, 'refill');
    const out = frame(s, refill.at(0) + 800);
    expect([out.segment, out.settled]).toStrictEqual([refill.index, true]);
    expect(of(out.offsetY)).toStrictEqual(cells([], 0, 0));
  });

  it('падение: через миг после старта — не в покое (все колонки в воздухе); к концу — покой', () => {
    const fall = segment(s, 'fall');
    expect(frame(s, fall.at(0) + 1).settled).toBe(false);
    expect(frame(s, fall.at(0.5)).settled).toBe(false);
    expect(frame(s, fall.at(1)).settled).toBe(true);
  });

  it('состояние кадра не помнит прошлого: после взрыва тот же SceneState в покое — всё сброшено', () => {
    const out = frame(s, segment(s, 'explode').at(0.5));
    frame(s, segment(s, 'highlight').at(0.1), out);
    frame(s, segment(s, 'tally').at(0.5), out);
    expect([of(out.alpha), of(out.scale), of(out.explode), of(out.highlight), of(out.spotPop), of(out.offsetY)]).toStrictEqual([
      cells([], 0, 1),
      cells([], 0, 1),
      cells([], 0, -1),
      cells([], 0, 0),
      cells([], 0, -1),
      cells([], 0, 0),
    ]);
    expect([out.contourStep, out.contourAlpha, out.settled]).toStrictEqual([-1, 0, true]);
  });
});

describe('сброс прежней сетки (retrigger, первая группа фриспинов)', () => {
  const s = schedule('retrigger');
  const clear = segment(s, 'clear', 1);
  const before = s.groups[3]?.start.grid ?? new Int8Array(49);
  const shown = Array.from(before, (symbol, cell) => (symbol === EMPTY_CELL ? -1 : cell)).filter((cell) => cell >= 0);

  it('на середине: прежняя сетка — альфа 0.5, ниже на CLEAR_DROP × 0.25', () => {
    expect(shown).toHaveLength(49);
    const out = frame(s, clear.at(0.5));
    expect(CLEAR_DROP).toBe(0.5);
    expect([of(out.alpha), of(out.offsetY), out.settled]).toStrictEqual([cells(shown, 0.5, 1), cells(shown, -0.125, 0), false]);
  });

  it('конец сброса — начало падения: прежняя сетка ушла целиком, альфа новой — 1', () => {
    const out = frame(s, clear.at(1));
    expect(of(out.alpha)).toStrictEqual(cells([], 0, 1));
    expect(out.segment).toBe(clear.index + 1);
  });
});

describe('фича: ядра и плашки (retrigger)', () => {
  const s = schedule('retrigger');
  const scatters = eventOf('retrigger', 'scatters').cells;

  it('ядра на 10 %: свечение ядер — 0.5; конец ядер — свечения нет', () => {
    const highlight = segment(s, 'scatters');
    expect(scatters).toStrictEqual([0, 19, 30]);
    expect(of(frame(s, highlight.at(0.1)).highlight)).toStrictEqual(cells(scatters, 0.5, 0));
    expect(of(frame(s, highlight.at(1)).highlight)).toStrictEqual(cells([], 0, 0));
  });

  it('плашка фичи: появление на четверти — 0.25, уход на середине — 0.5; на ней — 10 фриспинов', () => {
    const intro = frame(s, segment(s, 'plaqueIn').at(0.25));
    expect([intro.plaque, intro.plaqueValue, intro.plaqueAlpha]).toStrictEqual([PLAQUE.intro, 10, 0.25]);
    expect(of(intro.highlight)).toStrictEqual(cells([], 0, 0));
    const leaving = frame(s, segment(s, 'plaqueOut').at(0.5));
    expect([leaving.plaque, leaving.plaqueValue, leaving.plaqueAlpha]).toStrictEqual([PLAQUE.intro, 10, 0.5]);
  });

  it('ретриггер +5: появление 0.25, показ 1, уход на четверти 0.75; фриспинов было 3 — стало 3 + 5 − 1', () => {
    const shown = [segment(s, 'plaqueIn', 1).at(0.25), segment(s, 'plaqueShow').at(0.5), segment(s, 'plaqueOut', 1).at(0.25)].map((t) => {
      const out = frame(s, t);
      return [out.plaque, out.plaqueValue, out.plaqueAlpha];
    });
    expect(shown).toStrictEqual([
      [PLAQUE.retrigger, 5, 0.25],
      [PLAQUE.retrigger, 5, 1],
      [PLAQUE.retrigger, 5, 0.75],
    ]);
    const retrigger = s.groups.findIndex((group) => group.kind === 'retrigger');
    expect([s.groups[retrigger]?.start.freeSpinsLeft, s.groups[retrigger + 1]?.start.freeSpinsLeft]).toStrictEqual([3, 7]);
  });

  it('без празднования (строгий, раунд не выше ставки) ядра не светятся', () => {
    const fill = eventOf('small-win', 'fill');
    const events: RoundEvent[] = [
      fill,
      { t: 'scatters', cells: [0, 19, 30] },
      { t: 'fsStart', spins: 10 },
      { t: 'fsSpin', index: 1, left: 9 },
      fill,
      { t: 'end', payX100: 0 },
    ];
    const quiet = buildSchedule({ events, betMinor: 100, winMinor: 0, previousGrid: null }, STRICT);
    const out = frame(quiet, segment(quiet, 'scatters').at(0.5));
    expect([quiet.celebrates, out.segment]).toStrictEqual([false, segment(quiet, 'scatters').index]);
    expect(of(out.highlight)).toStrictEqual(cells([], 0, 0));
  });
});

describe('кап и празднование (biggest: 5000×)', () => {
  const s = schedule('biggest');

  it('плашка капа: 0.4 на 10 %, 1 на середине, 0.4 на 90 %; фриспины сгорели; после капа — плашки нет', () => {
    const cap = segment(s, 'cap');
    const at = (p: number): SceneState => frame(s, cap.at(p));
    expect([0.1, 0.5, 0.9].map((p) => [at(p).plaque, at(p).plaqueValue, at(p).freeSpinsLeft])).toStrictEqual([
      [PLAQUE.cap, 0, -1],
      [PLAQUE.cap, 0, -1],
      [PLAQUE.cap, 0, -1],
    ]);
    expect(at(0.1).plaqueAlpha).toBeCloseTo(0.4, 12);
    expect(at(0.5).plaqueAlpha).toBe(1);
    expect(at(0.9).plaqueAlpha).toBeCloseTo(0.4, 12);
    expect([at(1).plaque, at(1).plaqueAlpha]).toStrictEqual([PLAQUE.none, 0]);
  });

  it('празднование на 35 %: уровень 4, счётчик — 87.5 % выигрыша; к концу показа — погашено', () => {
    const celebrate = segment(s, 'celebrate');
    const out = frame(s, celebrate.at(0.35));
    expect(s.totalMinor).toBe(500_000);
    expect([out.bigWinLevel, out.bigWinMinor]).toStrictEqual([4, 437_500]);
    expect(out.bigWinProgress).toBeCloseTo(0.35, 12);
    const end = frame(s, s.durationMs);
    expect([end.bigWinLevel, end.bigWinProgress, end.bigWinMinor]).toStrictEqual([0, 0, 0]);
  });
});

describe('пустое расписание — пустое поле', () => {
  it.each([
    ['обычный', NORMAL],
    ['строгий', STRICT],
  ])('%s: групп нет, кадр — пустые клетки без точек, основная игра', (_name, options) => {
    const empty = buildSchedule({ events: [], betMinor: 100, winMinor: 0, previousGrid: null }, options);
    expect([empty.groups.length, empty.segments.length, empty.durationMs, empty.bigWinLevel]).toStrictEqual([0, 0, 0, 0]);
    const s = schedule('retrigger');
    const out = frame(s, segment(s, 'spots', 1).at(0.5));
    frame(empty, 0, out);
    expect([of(out.symbol), of(out.spotLevel)]).toStrictEqual([cells([], 0, EMPTY_CELL), cells([], 0, 0)]);
    expect([out.counterMinor, out.freeSpinsLeft, out.freeSpinIndex, out.group, out.segment]).toStrictEqual([0, -1, 0, 0, -1]);
  });
});

describe('SceneState', () => {
  const snapshot = (state: SceneState): unknown => ({
    symbol: of(state.symbol),
    offsetY: of(state.offsetY),
    alpha: of(state.alpha),
    scale: of(state.scale),
    highlight: of(state.highlight),
    explode: of(state.explode),
    spotLevel: of(state.spotLevel),
    spotPop: of(state.spotPop),
    scalars: [
      state.contourStep,
      state.contourAlpha,
      state.counterMinor,
      state.freeSpinsLeft,
      state.freeSpinIndex,
      state.plaque,
      state.plaqueAlpha,
      state.plaqueValue,
      state.bigWinLevel,
      state.bigWinProgress,
      state.bigWinMinor,
      state.group,
      state.segment,
      state.settled,
    ],
  });
  const EMPTY_FIELD = {
    symbol: cells([], 0, EMPTY_CELL),
    offsetY: cells([], 0, 0),
    alpha: cells([], 0, 1),
    scale: cells([], 0, 1),
    highlight: cells([], 0, 0),
    explode: cells([], 0, -1),
    spotLevel: cells([], 0, 0),
    spotPop: cells([], 0, -1),
    scalars: [-1, 0, 0, -1, 0, PLAQUE.none, 0, 0, 0, 0, 0, 0, -1, true],
  };

  it('новое состояние — пустое поле в покое', () => {
    expect(snapshot(new SceneState())).toStrictEqual(EMPTY_FIELD);
  });

  it('clear после грязного кадра — снова пустое поле в покое: каждое поле', () => {
    const out = new SceneState();
    for (const buffer of [out.symbol, out.offsetY, out.alpha, out.scale, out.highlight, out.explode, out.spotLevel, out.spotPop]) buffer.fill(3);
    Object.assign(out, {
      contourStep: 2,
      contourAlpha: 0.5,
      counterMinor: 95,
      freeSpinsLeft: 4,
      freeSpinIndex: 6,
      plaque: PLAQUE.cap,
      plaqueAlpha: 0.5,
      plaqueValue: 5,
      bigWinLevel: 4,
      bigWinProgress: 0.5,
      bigWinMinor: 437_500,
      group: 7,
      segment: 9,
      settled: false,
    });
    expect(snapshot(out)).not.toStrictEqual(EMPTY_FIELD);
    out.clear();
    expect(snapshot(out)).toStrictEqual(EMPTY_FIELD);
  });
});
