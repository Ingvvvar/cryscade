import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EventRecorder } from '../../../src/core/engine/index.ts';
import { GOLDEN_CONFIG } from '../../support/configs.ts';
import { verifyRound } from '../../support/round-model.ts';
import { GuardedRounds } from '../../support/watchdog.ts';

// Золотой хеш — булавка от регрессий, а не доказательство правильности: правильность держат литеральные
// сценарии и эталонная модель, и каждый раунд здесь сначала сверяется с моделью. Хеш меняет любое изменение
// потока символов, порядка обращений к источнику, правил или формата событий. Обновлять осознанно:
// в коммите — что изменилось и почему это правильно.
describe('золотой хеш', () => {
  it('конфиг заморожен целиком', () => {
    const nested = [
      GOLDEN_CONFIG,
      GOLDEN_CONFIG.sizeBands,
      GOLDEN_CONFIG.paytableX100,
      ...GOLDEN_CONFIG.paytableX100,
      GOLDEN_CONFIG.weights,
      GOLDEN_CONFIG.weights.base,
      GOLDEN_CONFIG.weights.free,
      GOLDEN_CONFIG.freeSpinsByScatters,
      GOLDEN_CONFIG.retrigger,
    ];
    expect(nested.every((part) => Object.isFrozen(part))).toBe(true);
  });

  it('SHA-256 событий сидов 0…999 и итоги прогона', () => {
    const recorder = new EventRecorder();
    const rounds = new GuardedRounds(GOLDEN_CONFIG, recorder);
    const hash = createHash('sha256');
    const summary = { totalX100: 0, wins: 0, features: 0, retriggers: 0, caps: 0 };
    for (let seed = 0; seed < 1000; seed++) {
      const payX100 = rounds.play(seed);
      const facts = verifyRound(GOLDEN_CONFIG, recorder.events);
      summary.totalX100 += payX100;
      if (payX100 > 0) summary.wins += 1;
      if (facts.featured) summary.features += 1;
      if (facts.capped) summary.caps += 1;
      summary.retriggers += facts.retriggers;
      hash.update(JSON.stringify(recorder.events));
      hash.update('\n');
    }

    expect({ sha256: hash.digest('hex'), ...summary }).toStrictEqual({
      sha256: '1b53d7cc30b3012ca56f3d3e6c0260079e9d72ddecd7f1dcc73ed096afbdd6a2',
      totalX100: 84395,
      wins: 524,
      features: 63,
      retriggers: 29,
      caps: 13,
    });
  });
});
