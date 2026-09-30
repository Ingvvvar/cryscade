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

  it('малый выигрыш: шаг каскада — подсветка, взрыв, точки, досыпка и подсчёт 0.35×', () => {
    const s = schedule('small-win');
    expect(kinds(s)).toStrictEqual(['fill', 'cascade']);
    expect(segmentsOf(s, 1)).toStrictEqual(['highlight', 'explode', 'spots', 'refill', 'tally']);
    expect([COUNTER(0.35), s.durationMs]).toStrictEqual([360, 220 + FALL_NORMAL + 450 + 260 + 280 + FALL_NORMAL + 360]);
    expect(s.tallies).toStrictEqual([{ from: 0, to: 35 }]);
  });

  it('три каскада — три группы шагов, подсчёт один, в конце спина', () => {
    const s = schedule('cascade-3');
    expect(kinds(s)).toStrictEqual(['fill', 'cascade', 'cascade', 'cascade']);
    expect(s.segments.filter((segment) => segment.kind === 'tally').map((segment) => segment.group)).toStrictEqual([3]);
  });

  it('старт фичи: группа фичи с точкой удержания featureIntro после появления плашки; 25.85× — «Крупный»', () => {
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

  it.each(FIXTURE_NAMES)('%s: конец показа — ровно итоговая сетка раунда, все клетки в покое, счётчик — выигрыш', (name) => {
    const s = schedule(name);
    const out = new SceneState();
    sampleScene(s, s.durationMs, out);
    const expected = verifyRound(DEFAULT_CONFIG, fixtureRound(name).events).finalGrid;
    expect([...out.symbol]).toStrictEqual(expected);
    expect([...out.symbol]).toStrictEqual(finalGrid(fixtureRound(name).events));
    expect([out.settled, out.segment, out.counterMinor]).toStrictEqual([true, -1, fixtureRound(name).payX100]);
    expect(out.offsetY.every((y) => y === 0)).toBe(true);
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

  it('контрпример property (сид раунда 1330553994, ставка 20, турбо): пауза дотягивает цикл ровно до 2500, без недобора', () => {
    const recorder = new EventRecorder();
    const payX100 = new SeededEngine(DEFAULT_CONFIG, recorder).play(1_330_553_994);
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

  it('обычный пресет празднует и выигрыш ≤ ставки', () => {
    expect(schedule('small-win').segments.filter((segment) => segment.celebrate).map((segment) => segment.kind)).toStrictEqual(['highlight', 'tally']);
  });
});

describe('кадр в ключевые моменты (литералы на small-win: ставка 100, выигрыш 35)', () => {
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
    expect([...out.highlight].every((value) => value === 0)).toBe(true);
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
    for (const [from, to] of refill.moves) expect(out.offsetY[to]).toBe((to - from) / 7);
    const perColumn = new Map<number, number>();
    for (const drop of refill.drops) perColumn.set(drop.cell % 7, (perColumn.get(drop.cell % 7) ?? 0) + 1);
    for (const drop of refill.drops) expect(out.offsetY[drop.cell]).toBe(perColumn.get(drop.cell % 7));
  });

  it('подсчёт на середине: floor(35 × (1 − 0.5³)) = 30', () => {
    const out = new SceneState();
    const at = segment('tally');
    sampleScene(s, (at.startMs + at.endMs) / 2, out);
    expect(out.counterMinor).toBe(30);
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
    expect([...(feature?.start.spots ?? [])].every((level) => level === 0)).toBe(true);
  });

  it('большой выигрыш: к 70 % празднования его счётчик — весь выигрыш, уровень 1', () => {
    const out = new SceneState();
    const at = s.segments.find((item) => item.kind === 'celebrate');
    sampleScene(s, (at?.startMs ?? 0) + 0.7 * ((at?.endMs ?? 0) - (at?.startMs ?? 0)), out);
    expect([out.bigWinLevel, out.bigWinMinor]).toStrictEqual([1, 2585]);
  });
});

describe('точки множителей: основная игра — с нуля, фриспины — живут', () => {
  it('multiplier-8: к концу раунда точки есть; на старте его заполнения — ноль', () => {
    const s = schedule('multiplier-8');
    const out = new SceneState();
    sampleScene(s, s.durationMs, out);
    expect([...out.spotLevel].some((level) => level >= 4)).toBe(true);
    expect([...(s.groups[0]?.start.spots ?? [])].every((level) => level === 0)).toBe(true);
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

  it('старт фичи чистит точки: первое заполнение фриспинов — без точек основного спина', () => {
    for (const name of ['retrigger', 'biggest'] as const) {
      const s = schedule(name);
      const feature = s.groups.findIndex((group) => group.kind === 'feature');
      const before = s.groups[feature]?.start.spots;
      const firstFree = s.groups[feature + 1]?.start.spots;
      expect([...(before ?? [])].some((level) => level > 0)).toBe(true);
      expect([...(firstFree ?? [])].every((level) => level === 0)).toBe(true);
    }
  });
});

