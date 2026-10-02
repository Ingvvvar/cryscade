import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EventRecorder } from '../../../src/core/engine/index.ts';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { finalGrid } from '../../../src/core/presentation/final-grid.ts';
import { STRESS_CONFIG } from '../../support/configs.ts';
import { FIXTURE_NAMES, fixtureRound } from '../../support/fixture-rounds.ts';
import { verifyRound } from '../../support/round-model.ts';
import { guarded } from '../../support/watchdog.ts';

// Итоговая сетка раунда — то, что остаётся на поле после показа. Сверка — с эталонной моделью, которая собирает
// сетку своим путём (падение колонки заново), и с сеткой, посчитанной вручную.

describe('finalGrid', () => {
  it('small-win: сетка после единственного каскада — посчитана вручную', () => {
    expect(finalGrid(fixtureRound('small-win').events)).toStrictEqual([
      5, 5, 0, 2, 0, 3, 0,
      2, 1, 6, 3, 2, 4, 1,
      0, 3, 0, 5, 3, 4, 3,
      0, 0, 6, 5, 1, 6, 0,
      0, 3, 3, 1, 3, 3, 2,
      2, 4, 4, 5, 2, 4, 6,
      1, 2, 3, 6, 4, 3, 0,
    ]);
  });

  it('loss: итоговая сетка — это fill', () => {
    const { events } = fixtureRound('loss');
    const fill = events[0];
    expect(fill?.t).toBe('fill');
    expect(finalGrid(events)).toStrictEqual(fill?.t === 'fill' ? fill.grid : null);
  });

  it.each(FIXTURE_NAMES)('%s: совпадает с эталонной моделью', (name) => {
    const { events } = fixtureRound(name);
    expect(finalGrid(events)).toStrictEqual(verifyRound(DEFAULT_CONFIG, events).finalGrid);
  });

  it('на капе сетка полная — кластеры не взорваны', () => {
    const { events } = fixtureRound('biggest');
    const grid = finalGrid(events);
    const lastWin = events.findLast((event) => event.t === 'win');
    expect(lastWin?.t).toBe('win');
    if (lastWin?.t !== 'win') return;
    expect(lastWin.clusters.length).toBeGreaterThan(0);
    for (const cluster of lastWin.clusters) {
      for (const cell of cluster.cells) expect(grid[cell]).toBe(cluster.symbol);
    }
  });

  it('события без полной сетки — ошибка вызывающего: бросает', () => {
    expect(() => finalGrid([{ t: 'end', payX100: 0 }])).toThrow(RangeError);
    expect(() => finalGrid([{ t: 'end', payX100: 0 }])).toThrow('finalGrid: по событиям не собирается полная сетка — сначала гард протокола');
  });

  it('взрыв без досыпки — в сетке дыры: бросает', () => {
    const { events } = fixtureRound('small-win');
    const exploded = events.slice(0, events.findIndex((event) => event.t === 'explode') + 1);
    expect(exploded.map((event) => event.t)).toStrictEqual(['fill', 'win', 'explode']);
    expect(() => finalGrid(exploded)).toThrow('finalGrid: по событиям не собирается полная сетка — сначала гард протокола');
  });

  it('на случайных раундах стресс-конфига совпадает с моделью', () => {
    const recorder = new EventRecorder();
    const engine = guarded(STRESS_CONFIG, recorder);
    let featured = 0;
    let capped = 0;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        engine.play(seed);
        const facts = verifyRound(STRESS_CONFIG, recorder.events);
        if (facts.featured) featured += 1;
        if (facts.capped) capped += 1;
        expect(finalGrid(recorder.events)).toStrictEqual(facts.finalGrid);
      }),
      { numRuns: 500 },
    );
    expect(featured).toBeGreaterThan(0);
    expect(capped).toBeGreaterThan(0);
  });
});
