import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { SeededRounds } from '../../../src/server/seeded-rounds.ts';
import { FIXTURE_NAMES, fixtureRound } from '../../support/fixture-rounds.ts';

// Раунд по сиду — одна дорога для живых раундов, лечения и заставки: по сиду фикстуры — её события и итог.

describe('SeededRounds', () => {
  it.each(FIXTURE_NAMES)('%s', (name) => {
    const fixture = fixtureRound(name);
    const played = new SeededRounds(DEFAULT_CONFIG, 100_000).play(fixture.seed);
    expect(played.payX100).toBe(fixture.payX100);
    expect(played.events).toStrictEqual(fixture.events);
  });

  it('каждый раунд — свой массив событий: следующий раунд прежний не меняет', () => {
    const rounds = new SeededRounds(DEFAULT_CONFIG, 100_000);
    const first = rounds.play(fixtureRound('small-win').seed);
    rounds.play(fixtureRound('cascade-3').seed);
    expect(first.events).toStrictEqual(fixtureRound('small-win').events);
  });
});
