import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EventRecorder } from '../../src/core/engine/index.ts';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import type { RoundEvent } from '../../src/core/model/events.ts';
import { configFingerprint } from '../../tools/math/fixture-specs.ts';
import { verifyRound, type RoundFacts } from '../support/round-model.ts';
import { guarded } from '../support/watchdog.ts';

// Фикстуры раундов (npm run fixtures): каждая проходит эталонную модель, её условие выполнено по фактам модели,
// она свежая — записана на текущем конфиге, и SeededEngine по её сиду даёт побайтно те же события.
// Условия здесь свои, по фактам модели, а не функции генератора.

const DIR = fileURLToPath(new URL('../../fixtures/rounds/', import.meta.url));

interface StoredFixture {
  readonly name: string;
  readonly seed: number;
  readonly configSha256: string;
  readonly payX100: number;
  readonly events: readonly RoundEvent[];
}

const CONDITIONS: Record<string, ((facts: RoundFacts) => boolean) | null> = {
  loss: (f) => f.payX100 === 0 && !f.featured,
  'small-win': (f) => f.payX100 > 0 && f.payX100 <= 100 && !f.featured,
  'base-win': (f) => f.payX100 > 100 && f.longestCascade === 1 && !f.featured,
  'cascade-3': (f) => f.longestCascade >= 3 && !f.featured,
  'multiplier-8': (f) => f.maxClusterMult >= 8,
  'feature-start': (f) => f.featured && f.retriggers === 0 && !f.capped,
  retrigger: (f) => f.retriggers >= 1,
  biggest: null,
};

const files = readdirSync(DIR).filter((file) => file.endsWith('.json')).sort();
const fixtures = files.map((file) => JSON.parse(readFileSync(path.join(DIR, file), 'utf8')) as StoredFixture);

describe('фикстуры раундов', () => {
  it('набор — ровно восемь: шесть из §15 и две для строгого пресета', () => {
    expect(fixtures.map((fixture) => fixture.name).sort()).toStrictEqual(Object.keys(CONDITIONS).sort());
  });

  describe.each(fixtures.map((fixture) => [fixture.name, fixture] as const))('%s', (name, fixture) => {
    it('записана на текущем конфиге игры — иначе пересобери: npm run fixtures', () => {
      expect(fixture.configSha256).toBe(configFingerprint(DEFAULT_CONFIG));
    });

    it('SeededEngine по сиду даёт побайтно те же события и итог', () => {
      const recorder = new EventRecorder();
      expect(guarded(DEFAULT_CONFIG, recorder).play(fixture.seed)).toBe(fixture.payX100);
      expect(JSON.stringify(recorder.events)).toBe(JSON.stringify(fixture.events));
    });

    it('проходит эталонную модель, и её условие выполнено', () => {
      const facts = verifyRound(DEFAULT_CONFIG, fixture.events);
      expect(facts.payX100).toBe(fixture.payX100);
      const condition = CONDITIONS[name];
      if (condition === null || condition === undefined) expect(facts.payX100).toBe(DEFAULT_CONFIG.capX100);
      else expect(condition(facts)).toBe(true);
    });

    it('сид — первый подходящий по возрастанию', () => {
      const condition = CONDITIONS[name];
      if (condition === null || condition === undefined) return;
      const recorder = new EventRecorder();
      const engine = guarded(DEFAULT_CONFIG, recorder);
      const earlier: number[] = [];
      for (let seed = 0; seed < fixture.seed; seed++) {
        engine.play(seed);
        if (condition(verifyRound(DEFAULT_CONFIG, recorder.events))) earlier.push(seed);
      }
      expect(earlier).toStrictEqual([]);
    });
  });
});
