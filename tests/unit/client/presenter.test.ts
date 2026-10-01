import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_KEY,
  PRESETS,
  Presenter,
  SessionCheckpoint,
  type CheckpointStore,
  type KeyValueStore,
  type PresentationSettings,
  type ShownRound,
} from '../../../src/client/index.ts';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { EMPTY_CELL, buildSchedule, type ScheduleOptions } from '../../../src/core/presentation/index.ts';
import { fixtureFirstGrid } from '../../support/fixture-rounds.ts';
import { verifyRound } from '../../support/round-model.ts';
import { fixtureShown, seedShown } from '../../support/shown-rounds.ts';

// Часы показа (§8.2): расписание раунда, время и кадр. Кадр — sampleScene в свой SceneState; здесь — то, что добавляет
// Presenter: прежняя сетка следующего раунда, ход и упор часов, стоянка на featureIntro, пропуск, скрытая вкладка,
// брошенный показ, контрольная точка (§6.5) и стоп-кадр зонда. Моменты — из расписания той же сборки: тест сверяет
// часы Presenter с границами групп, а не пересчитывает расписание.

const NORMAL: ScheduleOptions = { speed: 'normal', preset: PRESETS.standard, reducedMotion: false };
const TURBO: ScheduleOptions = { speed: 'turbo', preset: PRESETS.standard, reducedMotion: false };
const REST = fixtureFirstGrid('feature-start');
const SMALL: ShownRound = fixtureShown('small-win');
const SMALL_FINAL = verifyRound(DEFAULT_CONFIG, SMALL.events).finalGrid;
const CASCADES: ShownRound = fixtureShown('multiplier-8');
const FEATURE: ShownRound = fixtureShown('feature-start');

class MemoryCheckpoints implements CheckpointStore {
  readonly writes: [string, number][] = [];
  stored: { readonly roundId: string; readonly group: number } | null = null;

  read(roundId: string): number | null {
    return this.stored?.roundId === roundId ? this.stored.group : null;
  }

  write(roundId: string, group: number): void {
    this.writes.push([roundId, group]);
    this.stored = { roundId, group };
  }
}

function settings(options: ScheduleOptions[] = [], skip = true): PresentationSettings {
  return { options: () => options.shift() ?? NORMAL, skip };
}

interface Heard {
  held: number;
  finished: number;
}

function presenter(options: { readonly skip?: boolean; readonly checkpoints?: CheckpointStore; readonly speeds?: ScheduleOptions[] } = {}): {
  readonly presenter: Presenter;
  readonly heard: Heard;
} {
  const made = new Presenter(settings(options.speeds, options.skip ?? true), options.checkpoints ?? new MemoryCheckpoints());
  const heard: Heard = { held: 0, finished: 0 };
  made.listen({
    held: () => {
      heard.held += 1;
    },
    finished: () => {
      heard.finished += 1;
    },
  });
  return { presenter: made, heard };
}

describe('Presenter: часы', () => {
  it('до первой сетки показа нет: кадр пуст, конца нет', () => {
    const { presenter: show } = presenter();
    const scene = show.tick(16);
    expect(show.schedule).toBeNull();
    expect(show.finished).toBe(false);
    expect(Array.from(scene.symbol)).toStrictEqual(Array.from({ length: 49 }, () => EMPTY_CELL));
  });

  it('сетка покоя падает по расписанию; часы идут от тикера и упираются в конец; о покое контроллер не слышит', () => {
    const { presenter: show, heard } = presenter();
    show.rest(REST);
    const duration = show.schedule?.durationMs ?? 0;
    expect(duration).toBeGreaterThan(0);
    expect(show.tick(0).settled).toBe(true);
    show.tick(duration / 2);
    expect(show.clock).toBe(duration / 2);
    expect(show.finished).toBe(false);
    const end = show.tick(duration);
    expect(show.clock).toBe(duration);
    expect(show.finished).toBe(true);
    expect(Array.from(end.symbol)).toStrictEqual(REST);
    expect(heard).toStrictEqual({ held: 0, finished: 0 });
  });

  it('следующий раунд начинается с того, что лежит на поле: прежняя сетка — итог прошлого показа', () => {
    const { presenter: show } = presenter();
    show.rest(REST);
    show.play(SMALL, false);
    expect(show.clock).toBe(0);
    expect(Array.from(show.tick(0).symbol)).toStrictEqual(REST);
    show.tick(Number.MAX_SAFE_INTEGER);
    expect(Array.from(show.scene.symbol)).toStrictEqual(SMALL_FINAL);
    show.play(SMALL, false);
    expect(Array.from(show.tick(0).symbol)).toStrictEqual(SMALL_FINAL);
  });

  it('параметры показа читаются на старте раунда: турбо короче обычного ровно на расписание турбо', () => {
    const { presenter: show } = presenter({ speeds: [NORMAL, TURBO] });
    show.play(SMALL, false);
    const normal = show.schedule?.durationMs;
    show.play(SMALL, false);
    const turbo = show.schedule?.durationMs;
    const round = { events: SMALL.events, betMinor: SMALL.betMinor, winMinor: SMALL.winMinor };
    expect(normal).toBe(buildSchedule({ ...round, previousGrid: null }, NORMAL).durationMs);
    expect(turbo).toBe(buildSchedule({ ...round, previousGrid: SMALL_FINAL }, TURBO).durationMs);
    expect(turbo).toBeLessThan(normal ?? 0);
  });

  it('конец показа раунда — один раз, когда часы дошли до конца', () => {
    const { presenter: show, heard } = presenter();
    show.play(SMALL, false);
    const duration = show.schedule?.durationMs ?? 0;
    show.tick(duration - 1);
    expect(heard.finished).toBe(0);
    show.tick(1);
    show.tick(100);
    expect(heard).toStrictEqual({ held: 0, finished: 1 });
  });

  it('скрытая вкладка — часы стоят; снова видна — идут дальше с того же места', () => {
    const { presenter: show } = presenter();
    show.play(SMALL, false);
    show.tick(100);
    show.setHidden(true);
    show.tick(500);
    expect(show.clock).toBe(100);
    show.setHidden(false);
    show.tick(50);
    expect(show.clock).toBe(150);
  });

  it('брошенный показ: часы стоят, о конце никто не узнает; новый раунд идёт заново', () => {
    const { presenter: show, heard } = presenter();
    show.play(SMALL, false);
    show.tick(100);
    show.halt();
    show.tick(Number.MAX_SAFE_INTEGER);
    show.skip();
    expect(show.clock).toBe(100);
    expect(heard.finished).toBe(0);
    show.play(SMALL, false);
    show.tick(Number.MAX_SAFE_INTEGER);
    expect(heard.finished).toBe(1);
  });

  it('стоп-кадр зонда: часы стоят на t и тикером не двигаются; t за концом — конец; контроллер не слышит', () => {
    const { presenter: show, heard } = presenter();
    show.still(SMALL, 300, NORMAL);
    show.tick(1000);
    expect(show.clock).toBe(300);
    show.still(SMALL, Number.MAX_SAFE_INTEGER, NORMAL);
    expect(show.clock).toBe(show.schedule?.durationMs);
    expect(show.finished).toBe(true);
    expect(heard).toStrictEqual({ held: 0, finished: 0 });
    show.play(SMALL, false);
    show.tick(40);
    expect(show.clock).toBe(40);
  });
});

describe('Presenter: featureIntro', () => {
  it('часы встают на точке удержания и ждут resume; расписание то же; конец — после продолжения', () => {
    const { presenter: show, heard } = presenter();
    show.play(FEATURE, false);
    const schedule = show.schedule;
    const hold = schedule?.holds[0] ?? -1;
    expect(schedule?.holds).toHaveLength(1);
    show.tick(hold + 5000);
    expect(show.clock).toBe(hold);
    expect(show.held).toBe(true);
    expect(heard.held).toBe(1);
    show.tick(10_000);
    expect(show.clock).toBe(hold);
    show.resume();
    show.tick(10);
    expect(show.clock).toBe(hold + 10);
    expect(show.schedule).toBe(schedule);
    show.tick(Number.MAX_SAFE_INTEGER);
    expect(heard).toStrictEqual({ held: 1, finished: 1 });
  });
});

/** Начало первой группы единицы unit — конец предыдущей единицы; единицы нет — конец раунда. */
function unitStart(show: Presenter, unit: number): number {
  return show.schedule?.groups.find((group) => group.unit === unit)?.startMs ?? show.schedule?.durationMs ?? -1;
}

/** Показ фичи после плашки: часы на точке удержания, игрок продолжил. */
function pastIntro(show: Presenter): void {
  show.play(FEATURE, false);
  show.tick(show.schedule?.holds[0] ?? 0);
  show.resume();
}

describe('Presenter: пропуск', () => {
  it('основная игра без фичи и большого выигрыша: первый тап — к концу группы, второй — к концу спина, он же конец раунда', () => {
    const { presenter: show, heard } = presenter();
    show.play(CASCADES, false);
    const groups = show.schedule?.groups ?? [];
    expect(groups.length).toBeGreaterThan(3);
    expect(groups.every((group) => group.unit === 0)).toBe(true);
    show.tick((groups[1]?.startMs ?? 0) + 10);
    show.skip();
    expect(show.clock).toBe(groups[1]?.endMs);
    expect(heard.finished).toBe(0);
    show.skip();
    expect(show.clock).toBe(show.schedule?.durationMs);
    expect(heard.finished).toBe(1);
  });

  it('во фриспине второй тап — к концу этого фриспина, дальше часы идут сами; на старте следующего спина счёт с нуля', () => {
    const { presenter: show, heard } = presenter();
    pastIntro(show);
    const groups = show.schedule?.groups ?? [];
    const first = groups.findIndex((group) => group.unit === 1);
    expect(groups[first]?.kind).toBe('fill');
    show.tick((groups[first]?.startMs ?? 0) + 10 - show.clock);
    show.skip();
    expect(show.clock).toBe(groups[first]?.endMs);
    show.skip();
    expect(show.clock).toBe(unitStart(show, 2));
    expect([show.finished, heard.finished]).toStrictEqual([false, 0]);
    show.tick(40);
    expect(show.clock).toBe(unitStart(show, 2) + 40);
    // Спин из двух групп и больше: первый тап в нём — к концу группы, а не спина.
    const long = groups.find((group, k) => group.kind === 'fill' && group.unit >= 2 && groups[k + 1]?.unit === group.unit);
    if (long === undefined) throw new Error('нет фриспина из двух групп');
    show.tick(long.startMs - show.clock);
    show.skip();
    expect(show.clock).toBe(long.endMs);
    expect(long.endMs).toBeLessThan(unitStart(show, long.unit + 1));
  });

  it.each([
    ['последний фриспин', FEATURE],
    ['основной спин без фичи', seedShown(1590)],
  ])('%s: второй тап останавливает показ на начале празднования, празднование — своим тапом', (_name, round) => {
    const { presenter: show, heard } = presenter();
    show.play(round, false);
    const hold = show.schedule?.holds[0];
    if (hold !== undefined) {
      show.tick(hold);
      show.resume();
    }
    const groups = show.schedule?.groups ?? [];
    const celebration = groups.at(-1);
    expect(celebration?.kind).toBe('bigWin');
    const lastSpin = groups.find((group) => group.unit === (celebration?.unit ?? 0) - 1 && group.startMs >= show.clock);
    show.tick((lastSpin?.startMs ?? 0) + 10 - show.clock);
    show.skip();
    show.skip();
    expect(show.clock).toBe(celebration?.startMs);
    expect([show.finished, heard.finished]).toStrictEqual([false, 0]);
    show.skip();
    expect(show.clock).toBe(show.schedule?.durationMs);
    expect(heard.finished).toBe(1);
  });

  it('точку удержания пропуск не перепрыгивает; после продолжения тап — к концу основного спина, а не раунда', () => {
    const { presenter: show, heard } = presenter();
    show.play(FEATURE, false);
    const hold = show.schedule?.holds[0] ?? -1;
    show.skip();
    show.skip();
    expect(show.clock).toBe(hold);
    expect(heard.held).toBe(1);
    show.skip();
    expect(show.clock).toBe(hold);
    show.resume();
    show.skip();
    expect(show.clock).toBe(unitStart(show, 1));
    expect(heard).toStrictEqual({ held: 1, finished: 0 });
  });

  it('пресет без пропуска (строгий): тап ничего не пропускает', () => {
    const { presenter: show } = presenter({ skip: false });
    show.play(CASCADES, false);
    show.tick(10);
    show.skip();
    show.skip();
    expect(show.clock).toBe(10);
  });
});

describe('Presenter: контрольная точка', () => {
  it('пишется на старте раунда и на каждой границе группы; в pagehide — текущая группа', () => {
    const checkpoints = new MemoryCheckpoints();
    const { presenter: show } = presenter({ checkpoints });
    show.play(CASCADES, false);
    const groups = show.schedule?.groups ?? [];
    show.tick((groups[1]?.startMs ?? 0) - 1);
    show.tick(1);
    show.tick(1);
    expect(checkpoints.writes).toStrictEqual([
      ['multiplier-8', 0],
      ['multiplier-8', 1],
    ]);
    show.saveCheckpoint();
    expect(checkpoints.writes.at(-1)).toStrictEqual(['multiplier-8', 1]);
  });

  it('восстановление — с начала группы контрольной точки; точки нет или она чужая — с начала раунда', () => {
    const checkpoints = new MemoryCheckpoints();
    const { presenter: show } = presenter({ checkpoints });
    checkpoints.stored = { roundId: 'multiplier-8', group: 3 };
    show.play(CASCADES, true);
    expect(show.clock).toBe(show.schedule?.groups[3]?.startMs);
    expect(show.startMs).toBe(show.clock);
    expect(show.startMs).toBeGreaterThan(0);
    expect(show.group).toBe(3);
    checkpoints.stored = { roundId: 'другой', group: 3 };
    show.play(CASCADES, true);
    expect(show.clock).toBe(0);
    checkpoints.stored = { roundId: 'multiplier-8', group: 999 };
    show.play(CASCADES, true);
    expect(show.clock).toBe(0);
    checkpoints.stored = { roundId: 'multiplier-8', group: 3 };
    show.play(CASCADES, false);
    expect(show.clock).toBe(0);
  });

  it('восстановление в группу фичи — плашка всё равно ждёт игрока; в группу после неё — не ждёт', () => {
    const checkpoints = new MemoryCheckpoints();
    const { presenter: show, heard } = presenter({ checkpoints });
    show.play(FEATURE, false);
    const groups = show.schedule?.groups ?? [];
    const feature = groups.findIndex((group) => group.kind === 'feature');
    expect(feature).toBeGreaterThan(0);
    checkpoints.stored = { roundId: 'feature-start', group: feature };
    show.play(FEATURE, true);
    show.tick(Number.MAX_SAFE_INTEGER);
    expect(show.held).toBe(true);
    checkpoints.stored = { roundId: 'feature-start', group: feature + 1 };
    show.play(FEATURE, true);
    show.tick(Number.MAX_SAFE_INTEGER);
    expect(show.finished).toBe(true);
    expect(heard).toStrictEqual({ held: 1, finished: 1 });
  });
});

/** sessionStorage в памяти; broken — доступ бросает, как закрытое хранилище. */
class FakeSession implements KeyValueStore {
  readonly items = new Map<string, string>();
  broken = false;

  getItem(key: string): string | null {
    if (this.broken) throw new DOMException('closed', 'SecurityError');
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.broken) throw new DOMException('full', 'QuotaExceededError');
    this.items.set(key, value);
  }
}

describe('SessionCheckpoint', () => {
  it('запись и чтение своего раунда; чужой раунд и пусто — null', () => {
    const session = new FakeSession();
    const store = new SessionCheckpoint(() => session);
    expect(store.read('r1')).toBeNull();
    store.write('r1', 4);
    expect(session.items.get(CHECKPOINT_KEY)).toBe('{"roundId":"r1","group":4}');
    expect(store.read('r1')).toBe(4);
    expect(store.read('r2')).toBeNull();
  });

  it.each([['не JSON'], ['null'], ['[]'], ['{"roundId":"r1"}'], ['{"roundId":"r1","group":-1}'], ['{"roundId":"r1","group":1.5}'], ['{"roundId":"r1","group":"2"}'], ['{"roundId":1,"group":2}']])(
    'испорченная запись %s — null, а не исключение',
    (raw) => {
      const session = new FakeSession();
      session.items.set(CHECKPOINT_KEY, raw);
      expect(new SessionCheckpoint(() => session).read('r1')).toBeNull();
    },
  );

  it('хранилище недоступно — чтение null, запись молча; сам доступ к sessionStorage бросает — то же', () => {
    const session = new FakeSession();
    session.broken = true;
    const store = new SessionCheckpoint(() => session);
    expect(store.read('r1')).toBeNull();
    expect(() => {
      store.write('r1', 2);
    }).not.toThrow();
    const closed = new SessionCheckpoint(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(closed.read('r1')).toBeNull();
    expect(() => {
      closed.write('r1', 2);
    }).not.toThrow();
  });
});

describe('Presenter: ход часов для звука (§12)', () => {
  interface Heard {
    readonly started: [number, number][];
    readonly advanced: [number, number, boolean][];
  }

  function observed(options: { readonly checkpoints?: CheckpointStore } = {}): { readonly show: Presenter; readonly heard: Heard } {
    const { presenter: show } = presenter(options);
    const heard: Heard = { started: [], advanced: [] };
    show.observe({
      started: (schedule, fromMs) => heard.started.push([schedule.durationMs, fromMs]),
      advanced: (fromMs, toMs, jumped) => heard.advanced.push([fromMs, toMs, jumped]),
    });
    return { show, heard };
  }

  it('новый раунд — с 0; тикер — сдвиг без прыжка; пропуск — прыжок до конца группы; конец — упор, дальше ни слова', () => {
    const { show, heard } = observed();
    show.rest(REST);
    show.tick(16);
    expect(heard).toStrictEqual({ started: [], advanced: [] });
    show.play(SMALL, false);
    const schedule = buildSchedule({ events: SMALL.events, betMinor: SMALL.betMinor, winMinor: SMALL.winMinor, previousGrid: REST }, NORMAL);
    expect(heard.started).toStrictEqual([[schedule.durationMs, 0]]);
    show.tick(16);
    show.tick(20);
    expect(heard.advanced).toStrictEqual([
      [0, 16, false],
      [16, 36, false],
    ]);
    show.skip();
    const firstEnd = schedule.groups[0]?.endMs ?? -1;
    expect(heard.advanced.at(-1)).toStrictEqual([36, firstEnd, true]);
    show.tick(1_000_000);
    expect(heard.advanced.at(-1)).toStrictEqual([firstEnd, schedule.durationMs, false]);
    const before = heard.advanced.length;
    show.tick(16);
    expect(heard.advanced).toHaveLength(before);
  });

  it('подписался посреди раунда — слышит его с текущего места; после конца и на сетке покоя — нет', () => {
    const { presenter: show } = presenter();
    const heard: [number, number][] = [];
    const listener = {
      started: (schedule: { readonly durationMs: number }, fromMs: number) => heard.push([schedule.durationMs, fromMs]),
      advanced: () => undefined,
    };
    show.rest(REST);
    show.observe(listener);
    show.play(CASCADES, false);
    show.tick(500);
    show.observe(listener);
    const schedule = buildSchedule({ events: CASCADES.events, betMinor: CASCADES.betMinor, winMinor: CASCADES.winMinor, previousGrid: REST }, NORMAL);
    expect(heard).toStrictEqual([
      [schedule.durationMs, 0],
      [schedule.durationMs, 500],
    ]);
    show.tick(1_000_000);
    show.observe(listener);
    expect(heard).toHaveLength(2);
  });

  it('восстановленный раунд — с начала группы контрольной точки; брошенный показ — без хода; слушатель снят — тишина', () => {
    const checkpoints = new MemoryCheckpoints();
    checkpoints.stored = { roundId: CASCADES.roundId, group: 2 };
    const { show, heard } = observed({ checkpoints });
    show.play(CASCADES, true);
    const schedule = buildSchedule({ events: CASCADES.events, betMinor: CASCADES.betMinor, winMinor: CASCADES.winMinor, previousGrid: null }, NORMAL);
    expect(heard.started).toStrictEqual([[schedule.durationMs, schedule.groups[2]?.startMs]]);
    show.halt();
    show.tick(16);
    expect(heard.advanced).toStrictEqual([]);
    show.observe(null);
    show.play(SMALL, false);
    show.tick(16);
    expect([heard.started.length, heard.advanced]).toStrictEqual([1, []]);
  });
});
