import { readFileSync } from 'node:fs';
import type { RoundEvent } from '../../src/core/model/events.ts';

// Записанные раунды из fixtures/rounds/ (npm run fixtures): данные, независимые от сервера и гардов, —
// их сверяет с эталонной моделью tests/unit/fixtures.test.ts.

export interface FixtureRound {
  readonly name: string;
  readonly seed: number;
  readonly payX100: number;
  readonly events: readonly RoundEvent[];
}

export const FIXTURE_NAMES = [
  'loss',
  'small-win',
  'base-win',
  'cascade-3',
  'multiplier-8',
  'feature-start',
  'retrigger',
  'biggest',
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

export function fixtureRound(name: FixtureName): FixtureRound {
  const url = new URL(`../../fixtures/rounds/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as FixtureRound;
}
