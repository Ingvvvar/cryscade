import { describe, expect, it } from 'vitest';
import { PRESETS, Presenter, type ShownRound } from '../../../src/client/index.ts';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { EMPTY_CELL, buildSchedule, type ScheduleOptions } from '../../../src/core/presentation/index.ts';
import { fixtureFirstGrid } from '../../support/fixture-rounds.ts';
import { verifyRound } from '../../support/round-model.ts';
import { fixtureShown } from '../../support/shown-rounds.ts';

// Часы показа (§8.2): расписание раунда, время и кадр. Кадр — sampleScene в свой SceneState; здесь — то, что добавляет
// Presenter: прежняя сетка следующего раунда, ход и упор часов, стоп-кадр зонда, параметры на старте раунда.

const NORMAL: ScheduleOptions = { speed: 'normal', preset: PRESETS.standard, reducedMotion: false };
const TURBO: ScheduleOptions = { speed: 'turbo', preset: PRESETS.standard, reducedMotion: false };
const REST = fixtureFirstGrid('feature-start');
const SMALL: ShownRound = fixtureShown('small-win');
const SMALL_FINAL = verifyRound(DEFAULT_CONFIG, SMALL.events).finalGrid;

function settings(options: ScheduleOptions[]): { options(): ScheduleOptions } {
  return { options: () => options.shift() ?? NORMAL };
}

describe('Presenter', () => {
  it('до первой сетки показа нет: кадр пуст, конца нет', () => {
    const presenter = new Presenter(settings([]));
    const scene = presenter.tick(16);
    expect(presenter.schedule).toBeNull();
    expect(presenter.finished).toBe(false);
    expect(Array.from(scene.symbol)).toStrictEqual(Array.from({ length: 49 }, () => EMPTY_CELL));
  });

  it('сетка покоя падает по расписанию; часы идут от тикера и упираются в конец', () => {
    const presenter = new Presenter(settings([]));
    presenter.rest(REST);
    const duration = presenter.schedule?.durationMs ?? 0;
    expect(duration).toBeGreaterThan(0);
    expect(presenter.tick(0).settled).toBe(true);
    presenter.tick(duration / 2);
    expect(presenter.clock).toBe(duration / 2);
    expect(presenter.finished).toBe(false);
    const end = presenter.tick(duration);
    expect(presenter.clock).toBe(duration);
    expect(presenter.finished).toBe(true);
    expect(Array.from(end.symbol)).toStrictEqual(REST);
    expect(end.settled).toBe(true);
  });

  it('следующий раунд начинается с того, что лежит на поле: прежняя сетка — итог прошлого показа', () => {
    const presenter = new Presenter(settings([]));
    presenter.rest(REST);
    presenter.play(SMALL);
    expect(presenter.clock).toBe(0);
    expect(Array.from(presenter.tick(0).symbol)).toStrictEqual(REST);
    presenter.tick(Number.MAX_SAFE_INTEGER);
    expect(Array.from(presenter.scene.symbol)).toStrictEqual(SMALL_FINAL);
    presenter.play(SMALL);
    expect(Array.from(presenter.tick(0).symbol)).toStrictEqual(SMALL_FINAL);
  });

  it('параметры показа читаются на старте раунда: турбо короче обычного ровно на расписание турбо', () => {
    const presenter = new Presenter(settings([NORMAL, TURBO]));
    presenter.play(SMALL);
    const normal = presenter.schedule?.durationMs;
    presenter.play(SMALL);
    const turbo = presenter.schedule?.durationMs;
    const round = { events: SMALL.events, betMinor: SMALL.betMinor, winMinor: SMALL.winMinor };
    expect(normal).toBe(buildSchedule({ ...round, previousGrid: null }, NORMAL).durationMs);
    expect(turbo).toBe(buildSchedule({ ...round, previousGrid: SMALL_FINAL }, TURBO).durationMs);
    expect(turbo).toBeLessThan(normal ?? 0);
  });

  it('стоп-кадр зонда: часы стоят на t и тикером не двигаются; t за концом — конец', () => {
    const presenter = new Presenter(settings([]));
    presenter.still(SMALL, 300, NORMAL);
    presenter.tick(1000);
    expect(presenter.clock).toBe(300);
    presenter.still(SMALL, Number.MAX_SAFE_INTEGER, NORMAL);
    expect(presenter.clock).toBe(presenter.schedule?.durationMs);
    expect(presenter.finished).toBe(true);
    presenter.play(SMALL);
    presenter.tick(40);
    expect(presenter.clock).toBe(40);
  });
});
