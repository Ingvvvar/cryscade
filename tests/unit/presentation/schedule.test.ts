import { describe, expect, it } from 'vitest';
import { EventRecorder, SeededEngine } from '../../../src/core/engine/index.ts';
import { PRESETS } from '../../../src/core/jurisdiction.ts';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import {
  SceneState,
  buildSchedule,
  finalGrid,
  sampleScene,
  type Schedule,
  type ScheduleOptions,
} from '../../../src/core/presentation/index.ts';
import { clusterContour } from '../../../src/core/presentation/contour.ts';
import { FIXTURE_NAMES, fixtureRound, type FixtureName } from '../../support/fixture-rounds.ts';
import { verifyRound } from '../../support/round-model.ts';

// Расписание на фикстурах (§8.2, §8.5). Длительности — из чисел §8.3 и профиля падения фазы 3, посчитанных здесь
// заново, а не из констант кода. Ставка — 100: выигрыш = payX100.

const NORMAL: ScheduleOptions = { speed: 'normal', preset: PRESETS.standard, reducedMotion: false };
const STRICT: ScheduleOptions = { speed: 'normal', preset: PRESETS.strict, reducedMotion: false };
/** Колонки 6 × 45 мс, касание 380, два отскока с e = 0.22: 2·e·380 и 2·e²·380 — 853.984, сегмент — целые мс. */
const FALL_NORMAL = Math.round(6 * 45 + 380 + 2 * 0.22 * 380 + 2 * 0.22 * 0.22 * 380);
const COUNTER = (times: number): number => Math.round(300 + (1700 * Math.log10(1 + times)) / Math.log10(5001));

function schedule(name: FixtureName, options: ScheduleOptions = NORMAL, previousGrid: readonly number[] | null = null): Schedule {
  const round = fixtureRound(name);
  return buildSchedule({ events: round.events, betMinor: 100, winMinor: round.payX100, previousGrid }, options);
}

const kinds = (s: Schedule): string[] => s.groups.map((group) => group.kind);
/** Все 49 клеток — ноль: сравнение с длиной, а не every, — пустой или короткий массив не проходит. */
const ALL_ZERO = new Array<boolean>(49).fill(true);
const zeros = (values: ArrayLike<number>): boolean[] => Array.from(values, (value) => value === 0);
const segmentsOf = (s: Schedule, group: number): string[] => {
  const g = s.groups[group];
  return g === undefined ? [] : s.segments.slice(g.firstSegment, g.segmentEnd).map((segment) => segment.kind);
};

describe('расписание фикстур', () => {
  it('проигрыш: сброс прежней сетки и падение новой', () => {
    const s = schedule('loss');
    expect(kinds(s)).toStrictEqual(['fill']);
    expect(segmentsOf(s, 0)).toStrictEqual(['clear', 'fall']);
    expect([FALL_NORMAL, s.durationMs]).toStrictEqual([854, 220 + 854]);
  });

  it('малый выигрыш: шаг каскада — подсветка, взрыв, точки, досыпка и подсчёт 0.95×', () => {
    const s = schedule('small-win');
    expect(kinds(s)).toStrictEqual(['fill', 'cascade']);
    expect(segmentsOf(s, 1)).toStrictEqual(['highlight', 'explode', 'spots', 'refill', 'tally']);
    // 300 + 1700 × lg 1.95 / lg 5001 = 433.29.
    expect([COUNTER(0.95), s.durationMs]).toStrictEqual([433, 220 + FALL_NORMAL + 450 + 260 + 280 + FALL_NORMAL + 433]);
    expect(s.tallies).toStrictEqual([{ from: 0, to: 95 }]);
  });

  it('три каскада — три группы шагов, подсчёт один, в конце спина', () => {
    const s = schedule('cascade-3');
    expect(kinds(s)).toStrictEqual(['fill', 'cascade', 'cascade', 'cascade']);
    expect(s.segments.filter((segment) => segment.kind === 'tally').map((segment) => segment.group)).toStrictEqual([3]);
  });

  it('старт фичи: группа фичи с точкой удержания featureIntro после появления плашки; 33.50× — «Крупный»', () => {
    const s = schedule('feature-start');
    const feature = kinds(s).indexOf('feature');
    expect(segmentsOf(s, feature)).toStrictEqual(['scatters', 'plaqueIn', 'plaqueOut']);
    const intro = s.segments.find((segment) => segment.kind === 'plaqueIn');
    expect(s.holds).toStrictEqual([intro?.endMs]);
    expect(kinds(s).at(-1)).toBe('bigWin');
    expect(s.bigWinLevel).toBe(1);
    expect(s.plaques[0]).toStrictEqual({ kind: 1, value: 10 });
  });

  it('ретриггер — своя группа, плашка с добавкой, без удержания', () => {
    const s = schedule('retrigger');
    const retrigger = kinds(s).indexOf('retrigger');
    expect(segmentsOf(s, retrigger)).toStrictEqual(['scatters', 'plaqueIn', 'plaqueShow', 'plaqueOut']);
    expect(s.holds).toHaveLength(1);
  });

  it('кап: последний шаг — подсветка, плашка капа, подсчёт до итога; уровень «Максимум»', () => {
    const s = schedule('biggest');
    const last = s.groups.length - 2;
    expect(segmentsOf(s, last)).toStrictEqual(['highlight', 'cap', 'tally']);
    expect(s.tallies.at(-1)?.to).toBe(500_000);
    expect(s.bigWinLevel).toBe(4);
  });

  // biggest — раунд принудительного maxWin (сид 801200): кап в 12-м фриспине, после него по fsSpin осталось 3.
  it('кап (biggest = maxWin): с начала плашки капа фриспинов нет — ни в празднование, ни в итоговом кадре', () => {
    const s = schedule('biggest');
    const capAt = s.segments.find((segment) => segment.kind === 'cap');
    if (capAt === undefined) throw new Error('нет сегмента капа');
    const out = new SceneState();
    sampleScene(s, capAt.startMs - 1, out);
    expect(out.freeSpinsLeft).toBe(3);
    const after: number[] = [];
    for (let t = capAt.startMs; t <= s.durationMs; t += 25) {
      sampleScene(s, t, out);
      after.push(out.freeSpinsLeft);
    }
    sampleScene(s, s.durationMs, out);
    after.push(out.freeSpinsLeft);
    expect(after.length).toBeGreaterThan(100);
    expect(new Set(after)).toStrictEqual(new Set([-1]));
    expect(s.groups.at(-1)?.kind).toBe('bigWin');
    expect(s.groups.at(-1)?.start.freeSpinsLeft).toBe(-1);
  });

  it.each(FIXTURE_NAMES)('%s: конец показа — ровно итоговая сетка раунда, все клетки в покое, счётчик — выигрыш', (name) => {
    const s = schedule(name);
    const out = new SceneState();
    sampleScene(s, s.durationMs, out);
    const expected = verifyRound(DEFAULT_CONFIG, fixtureRound(name).events).finalGrid;
    expect([...out.symbol]).toStrictEqual(expected);
    expect([...out.symbol]).toStrictEqual(finalGrid(fixtureRound(name).events));
    expect([out.settled, out.segment, out.counterMinor]).toStrictEqual([true, -1, fixtureRound(name).payX100]);
    expect(zeros(out.offsetY)).toStrictEqual(ALL_ZERO);
  });

  it('прежняя сетка — на поле в начале и уходит за время сброса', () => {
    const previous = finalGrid(fixtureRound('base-win').events);
    const s = schedule('loss', NORMAL, previous);
    const out = new SceneState();
    sampleScene(s, 0, out);
    expect([...out.symbol]).toStrictEqual(previous);
    sampleScene(s, 110, out);
    expect([out.alpha[0], out.offsetY[0], out.settled]).toStrictEqual([0.5, -0.125, false]);
    sampleScene(s, 220, out);
    expect([...out.symbol]).toStrictEqual(finalGrid(fixtureRound('loss').events));
  });
});

describe('единицы пропуска (§8.2): спины и празднование', () => {
  it('фича: основной спин с плашкой, десять фриспинов, празднование — своя единица', () => {
    const s = schedule('feature-start');
    expect(s.groups.map((group) => [group.kind, group.unit])).toStrictEqual([
      ['fill', 0],
      ['feature', 0],
      ['fill', 1],
      ['cascade', 1],
      ['fill', 2],
      ['fill', 3],
      ['cascade', 3],
      ['fill', 4],
      ['fill', 5],
      ['fill', 6],
      ['fill', 7],
      ['cascade', 7],
      ['fill', 8],
      ['cascade', 8],
      ['cascade', 8],
      ['fill', 9],
      ['fill', 10],
      ['cascade', 10],
      ['cascade', 10],
      ['bigWin', 11],
    ]);
  });

  it('ретриггер — в спине, который его открыл; без большого выигрыша последний спин кончается с раундом', () => {
    const s = schedule('retrigger');
    const retrigger = s.groups.find((group) => group.kind === 'retrigger');
    const opener = s.groups.filter((group) => group.kind === 'fill' && group.startMs < (retrigger?.startMs ?? 0)).at(-1);
    expect(retrigger?.unit).toBe(opener?.unit);
    expect(s.groups.some((group) => group.kind === 'bigWin')).toBe(false);
    expect(s.unitEnds.at(-1)).toBe(s.durationMs);
  });

  it.each(FIXTURE_NAMES)('%s: единица — заполнения до группы, празднование — за последним спином; конец — начало следующей', (name) => {
    const s = schedule(name);
    const events = fixtureRound(name).events;
    for (const group of s.groups) {
      const fills = events.slice(0, group.fromEvent + 1).filter((event) => event.t === 'fill').length;
      expect(group.unit).toBe(group.kind === 'bigWin' ? fills : fills - 1);
    }
    expect(s.unitEnds).toHaveLength((s.groups.at(-1)?.unit ?? -1) + 1);
    s.unitEnds.forEach((end, unit) => {
      expect(end).toBe(s.groups.find((group) => group.unit === unit + 1)?.startMs ?? s.durationMs);
    });
  });
});

describe('параметры меняют длительности, но не состав групп', () => {
  const variants: ScheduleOptions[] = [
    NORMAL,
    { ...NORMAL, speed: 'turbo' },
    { ...NORMAL, reducedMotion: true },
    { speed: 'turbo', preset: PRESETS.standard, reducedMotion: true },
    STRICT,
  ];

  it.each(FIXTURE_NAMES)('%s: группы, их события и единицы пропуска одинаковы при любой скорости, пресете и reduced motion', (name) => {
    const shapes = variants.map((options) => schedule(name, options).groups.map((group) => [group.kind, group.fromEvent, group.toEvent, group.unit]));
    expect(shapes).toHaveLength(5);
    for (const shape of shapes) expect(shape).toStrictEqual(shapes[0]);
  });

  it('турбо короче обычного; reduced motion — падение без отскока', () => {
    expect(schedule('cascade-3', { ...NORMAL, speed: 'turbo' }).durationMs).toBeLessThan(schedule('cascade-3').durationMs);
    expect(schedule('loss', { ...NORMAL, reducedMotion: true }).profile).toStrictEqual({ touchMs: 200, restitution: 0, bounces: 0, columnDelayMs: 20 });
  });

  it('reduced motion и скорость — поля расписания раунда: рендер берёт из них частицы до конца раунда', () => {
    expect(schedule('cascade-3', { ...NORMAL, reducedMotion: true }).reducedMotion).toBe(true);
    expect(schedule('cascade-3').reducedMotion).toBe(false);
    expect(schedule('cascade-3', { ...NORMAL, speed: 'turbo' }).speed).toBe('turbo');
    expect(schedule('cascade-3').speed).toBe('normal');
  });
});

describe('строгий пресет (§8.5)', () => {
  it('выигрыш ≤ ставки: празднующих сегментов нет, подсчёт мгновенный, цикл не короче 2500 мс', () => {
    for (const name of ['small-win', 'loss'] as const) {
      const s = schedule(name, STRICT);
      expect(s.segments.filter((segment) => segment.celebrate)).toStrictEqual([]);
      expect(s.durationMs).toBeGreaterThanOrEqual(2500);
    }
    const tally = schedule('small-win', STRICT).segments.find((segment) => segment.kind === 'tally');
    expect(tally === undefined ? null : tally.endMs - tally.startMs).toBe(0);
    expect(schedule('loss', STRICT).segments.at(-1)?.kind).toBe('pause');
  });

  // Прежний контрпример property — сид 1330553994 (недобор 2499.9999999999995): при таблице варианта 4 он платит 1.90×,
  // празднуется и паузы не даёт (2653 мс). Тот же случай — пауза после подсчёта в турбо — у сида 2 (base-win, 1.90×).
  it('пауза после подсчёта (сид 2, ставка 20, турбо) дотягивает цикл ровно до 2500, без недобора', () => {
    const recorder = new EventRecorder();
    const payX100 = new SeededEngine(DEFAULT_CONFIG, recorder).play(2);
    const s = buildSchedule(
      { events: [...recorder.events], betMinor: 20, winMinor: Math.floor((20 * payX100) / 100), previousGrid: null },
      { speed: 'turbo', preset: PRESETS.strict, reducedMotion: false },
    );
    expect(s.durationMs).toBeGreaterThanOrEqual(2500);
    expect(s.segments.at(-1)?.endMs).toBe(2500);
  });

  it('выигрыш больше ставки празднуется и в строгом', () => {
    expect(schedule('base-win', STRICT).segments.some((segment) => segment.celebrate)).toBe(true);
  });

  it('строгий: выигрыш ровно в ставку (1.00×) не празднуется, на сотую больше — празднуется', () => {
    // small-win с выплатой кластера и итогом, подменёнными на границу: решает только итог раунда против ставки.
    const paid = (payX100: number): Schedule =>
      buildSchedule(
        {
          events: fixtureRound('small-win').events.map((event) =>
            event.t === 'win' ? { ...event, clusters: event.clusters.map((cluster) => ({ ...cluster, payX100 })) } : event.t === 'end' ? { ...event, payX100 } : event,
          ),
          betMinor: 100,
          winMinor: payX100,
          previousGrid: null,
        },
        STRICT,
      );
    expect([paid(100).celebrates, paid(101).celebrates]).toStrictEqual([false, true]);
  });

  it('обычный пресет празднует и выигрыш ≤ ставки', () => {
    expect(schedule('small-win').segments.filter((segment) => segment.celebrate).map((segment) => segment.kind)).toStrictEqual(['highlight', 'tally']);
  });
});

describe('кадр в ключевые моменты (литералы на small-win: ставка 100, выигрыш 95)', () => {
  const s = schedule('small-win');
  const segment = (kind: string) => {
    const found = s.segments.find((item) => item.kind === kind);
    if (found === undefined) throw new Error(`нет сегмента ${kind}`);
    return found;
  };
  const step = s.steps[0];
  const won = step === undefined ? [] : [...step.won].flatMap((flag, cell) => (flag === 1 ? [cell] : []));

  it('подсветка: на середине — свечение у клеток кластера, контур шага виден; у остальных — ноль', () => {
    const out = new SceneState();
    const at = segment('highlight');
    sampleScene(s, (at.startMs + at.endMs) / 2, out);
    expect(won.length).toBeGreaterThan(0);
    expect(won.map((cell) => out.highlight[cell])).toStrictEqual(won.map(() => 1));
    expect([...out.highlight].filter((value) => value > 0)).toHaveLength(won.length);
    expect([out.contourStep, out.contourAlpha]).toStrictEqual([0, 1]);
  });

  it('строгий пресет: подсветка без свечения, контур — есть', () => {
    const strict = schedule('small-win', STRICT);
    const at = strict.segments.find((item) => item.kind === 'highlight');
    const out = new SceneState();
    sampleScene(strict, ((at?.startMs ?? 0) + (at?.endMs ?? 0)) / 2, out);
    expect(zeros(out.highlight)).toStrictEqual(ALL_ZERO);
    expect(out.contourAlpha).toBe(1);
  });

  it('между взрывом и досыпкой клетки взрыва пусты', () => {
    const out = new SceneState();
    sampleScene(s, segment('spots').startMs, out);
    const exploded = step === undefined ? [] : [...step.exploded].flatMap((flag, cell) => (flag === 1 ? [cell] : []));
    expect(exploded.length).toBeGreaterThan(0);
    expect(exploded.map((cell) => out.symbol[cell])).toStrictEqual(exploded.map(() => -1));
  });

  it('досыпка на старте: сдвинутый символ — выше на число пройденных рядов, новый — на число новых в колонке', () => {
    const out = new SceneState();
    sampleScene(s, segment('refill').startMs, out);
    const refill = fixtureRound('small-win').events.find((event) => event.t === 'refill');
    if (refill?.t !== 'refill') throw new Error('нет refill');
    expect(refill.moves.length).toBeGreaterThan(0);
    expect(refill.drops.length).toBeGreaterThan(0);
    for (const [from, to] of refill.moves) expect(out.offsetY[to]).toBe((to - from) / 7);
    const perColumn = new Map<number, number>();
    for (const drop of refill.drops) perColumn.set(drop.cell % 7, (perColumn.get(drop.cell % 7) ?? 0) + 1);
    for (const drop of refill.drops) expect(out.offsetY[drop.cell]).toBe(perColumn.get(drop.cell % 7));
  });

  it('подсчёт на середине: floor(95 × (1 − 0.5³)) = 83', () => {
    const out = new SceneState();
    const at = segment('tally');
    sampleScene(s, (at.startMs + at.endMs) / 2, out);
    expect(out.counterMinor).toBe(83);
  });
});

describe('кадр фичи и большого выигрыша (feature-start)', () => {
  const s = schedule('feature-start');

  it('на точке удержания плашка фичи видна целиком: 10 фриспинов', () => {
    const out = new SceneState();
    sampleScene(s, s.holds[0] ?? 0, out);
    expect([out.plaque, out.plaqueValue, out.plaqueAlpha]).toStrictEqual([1, 10, 1]);
  });

  it('фриспины: у группы заполнения — номер и остаток; точки основной игры сброшены на старте фичи', () => {
    const fills = s.groups.filter((group) => group.kind === 'fill');
    expect(fills.slice(1).map((group) => [group.start.freeSpinIndex, group.start.freeSpinsLeft])).toStrictEqual(
      Array.from({ length: 10 }, (_, k) => [k + 1, 9 - k]),
    );
    const feature = s.groups.find((group) => group.kind === 'feature');
    expect(zeros(feature?.start.spots ?? [])).toStrictEqual(ALL_ZERO);
  });

  it('большой выигрыш: к 70 % празднования его счётчик — весь выигрыш, уровень 1', () => {
    const out = new SceneState();
    const at = s.segments.find((item) => item.kind === 'celebrate');
    sampleScene(s, (at?.startMs ?? 0) + 0.7 * ((at?.endMs ?? 0) - (at?.startMs ?? 0)), out);
    expect([out.bigWinLevel, out.bigWinMinor]).toStrictEqual([1, 3350]);
  });
});

describe('точки множителей: основная игра — с нуля, фриспины — живут', () => {
  it('multiplier-8: к концу раунда точки есть; на старте его заполнения — ноль', () => {
    const s = schedule('multiplier-8');
    const out = new SceneState();
    sampleScene(s, s.durationMs, out);
    expect([...out.spotLevel].some((level) => level >= 4)).toBe(true);
    expect(zeros(s.groups[0]?.start.spots ?? [])).toStrictEqual(ALL_ZERO);
  });

  it('retrigger: точки, набранные во фриспине, живут в следующем заполнении', () => {
    const s = schedule('retrigger');
    const fills = s.groups.filter((group) => group.kind === 'fill').slice(1);
    expect(fills.some((group) => [...group.start.spots].some((level) => level > 0))).toBe(true);
  });
});

describe('границы групп, пустые точки, колонки', () => {
  it('на старте группы кадр — уже эта группа: индекс группы — контрольная точка восстановления', () => {
    const s = schedule('cascade-3');
    const out = new SceneState();
    expect(s.groups.length).toBeGreaterThan(1);
    s.groups.forEach((group, index) => {
      sampleScene(s, group.startMs, out);
      expect(out.group).toBe(index);
    });
  });

  it('пустой spots — сегмент нулевой длины: показывать нечего', () => {
    const round = fixtureRound('small-win');
    const events = round.events.map((event) => (event.t === 'spots' ? { t: 'spots' as const, cells: [], levels: [] } : event));
    const s = buildSchedule({ events, betMinor: 100, winMinor: 35, previousGrid: null }, NORMAL);
    const spots = s.segments.find((segment) => segment.kind === 'spots');
    expect(spots === undefined ? null : spots.endMs - spots.startMs).toBe(0);
  });

  it('падение колонками: через 45 мс нулевая колонка прошла (45/380)² пути, первая — только стартует', () => {
    const s = schedule('loss');
    const fall = s.segments.find((segment) => segment.kind === 'fall');
    const out = new SceneState();
    sampleScene(s, (fall?.startMs ?? 0) + 45, out);
    expect(out.offsetY[0]).toBeCloseTo(7 * (1 - (45 / 380) ** 2), 5);
    expect([out.offsetY[1], out.offsetY[2], out.offsetY[7]]).toStrictEqual([7, 7, out.offsetY[0]]);
  });

  it('выигрыш основного спина подсчитан до ядер фичи: подсчёт — в его каскаде, а не после плашки', () => {
    const s = schedule('retrigger');
    const feature = s.groups.findIndex((group) => group.kind === 'feature');
    expect([segmentsOf(s, feature - 1).at(-1), segmentsOf(s, feature)]).toStrictEqual(['tally', ['scatters', 'plaqueIn', 'plaqueOut']]);
  });

  it('старт фичи чистит точки: первое заполнение фриспинов — без точек основного спина', () => {
    // retrigger и сид 466 (уровень 3 большого выигрыша): у обоих основной спин оставил точки перед фичей.
    const recorder = new EventRecorder();
    const payX100 = new SeededEngine(DEFAULT_CONFIG, recorder).play(466);
    const seeded = buildSchedule({ events: [...recorder.events], betMinor: 100, winMinor: payX100, previousGrid: null }, NORMAL);
    for (const s of [schedule('retrigger'), seeded]) {
      const feature = s.groups.findIndex((group) => group.kind === 'feature');
      const before = s.groups[feature]?.start.spots;
      const firstFree = s.groups[feature + 1]?.start.spots;
      expect([...(before ?? [])].some((level) => level > 0)).toBe(true);
      expect(zeros(firstFree ?? [])).toStrictEqual(ALL_ZERO);
    }
  });
});


describe('состав расписания: группы, сегменты, данные', () => {
  /** Вид, данные, празднование, вспышка и длительность сегментов. */
  const shape = (s: Schedule): (string | number | boolean)[][] =>
    s.segments.map((segment) => [segment.kind, segment.data, segment.celebrate, segment.flash, segment.endMs - segment.startMs]);

  it('small-win: заполнение 0…1, каскад 1…6 (с end); вспышки — подсветка и взрыв, празднуют подсветка и подсчёт', () => {
    const s = schedule('small-win');
    expect(s.groups.map((group) => [group.kind, group.fromEvent, group.toEvent, group.start.freeSpinsLeft])).toStrictEqual([
      ['fill', 0, 1, -1],
      ['cascade', 1, 6, -1],
    ]);
    expect(shape(s)).toStrictEqual([
      ['clear', -1, false, false, 220],
      ['fall', 0, false, false, FALL_NORMAL],
      ['highlight', 0, true, true, 450],
      ['explode', 0, false, true, 260],
      ['spots', 0, false, false, 280],
      ['refill', 0, false, false, FALL_NORMAL],
      ['tally', 0, true, false, COUNTER(0.95)],
    ]);
    expect([s.fills.length, s.steps.length, s.tallies]).toStrictEqual([1, 1, [{ from: 0, to: 95 }]]);
  });

  it('шаг каскада несёт кластеры: символ, клетки и контур клеток', () => {
    const s = schedule('small-win');
    const cells = [8, 10, 15, 16, 17];
    expect(s.steps[0]?.clusters).toStrictEqual([{ symbol: 1, cells, contour: clusterContour(cells) }]);
  });

  it('multiplier-8: каждая группа каскада — свои четыре события; последняя кончается на end', () => {
    expect(schedule('multiplier-8').groups.map((group) => [group.kind, group.fromEvent, group.toEvent])).toStrictEqual([
      ['fill', 0, 1],
      ['cascade', 1, 5],
      ['cascade', 5, 9],
      ['cascade', 9, 13],
      ['cascade', 13, 17],
      ['cascade', 17, 22],
    ]);
  });

  it('biggest: кап — 400 + 700 + 300 мс на плашке 1; празднование — без данных, празднует и вспыхивает', () => {
    const s = schedule('biggest');
    expect(shape(s).filter(([kind]) => kind === 'cap' || kind === 'celebrate')).toStrictEqual([
      ['cap', 1, false, false, 1400],
      ['celebrate', -1, true, true, 5500],
    ]);
    expect(s.plaques).toStrictEqual([
      { kind: 1, value: 15 },
      { kind: 3, value: 0 },
    ]);
  });

  it('retrigger: заполнения и ядра — по одному на событие; падение и ядра указывают на своё', () => {
    const s = schedule('retrigger');
    const events = fixtureRound('retrigger').events;
    const fills = events.filter((event) => event.t === 'fill').length;
    expect([s.fills.length, s.scatterSets.length]).toStrictEqual([fills, 2]);
    expect(s.segments.filter((segment) => segment.kind === 'fall').map((segment) => segment.data)).toStrictEqual(Array.from({ length: fills }, (_, k) => k));
    expect(s.segments.filter((segment) => segment.kind === 'scatters').map((segment) => segment.data)).toStrictEqual([0, 1]);
    expect(s.fills.map((fill) => fill.length)).toStrictEqual(new Array<number>(fills).fill(49));
  });

  it('событие до заполнения и шаг каскада без выигрыша — ошибка вызывающего', () => {
    const fill = fixtureRound('small-win').events[0];
    if (fill?.t !== 'fill') throw new Error('нет fill');
    const build = (events: Parameters<typeof buildSchedule>[0]['events']) => (): Schedule => buildSchedule({ events, betMinor: 100, winMinor: 0, previousGrid: null }, NORMAL);
    expect(build([{ t: 'explode', cells: [1] }])).toThrow(new Error('расписание: событие до fill'));
    expect(build([fill, { t: 'explode', cells: [1] }])).toThrow(new Error('расписание: шаг каскада без win'));
  });

  it('цикл ровно на минимуме — паузы нет; на 1 мс короче — пауза в 1 мс до минимума', () => {
    const planned = schedule('loss').durationMs;
    const exact = schedule('loss', { ...NORMAL, preset: { minSpinCycleMs: planned, celebrateSmallWins: true } });
    const longer = schedule('loss', { ...NORMAL, preset: { minSpinCycleMs: planned + 1, celebrateSmallWins: true } });
    expect([exact.durationMs, kinds(exact).length, exact.segments.some((segment) => segment.kind === 'pause')]).toStrictEqual([planned, 1, false]);
    expect([longer.durationMs, longer.segments.at(-1)?.kind, (longer.segments.at(-1)?.endMs ?? 0) - (longer.segments.at(-1)?.startMs ?? 0)]).toStrictEqual([planned + 1, 'pause', 1]);
  });
});
