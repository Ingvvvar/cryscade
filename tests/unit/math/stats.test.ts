import { describe, expect, it } from 'vitest';
import { RoundEngine, StatsRecorder } from '../../../src/core/engine/index.ts';
import { MathStats } from '../../../tools/math/stats.ts';
import { TEST_CONFIG } from '../../support/configs.ts';
import { BACKGROUND, ScenarioSource, drops, fill } from '../../support/scenario.ts';

// Ячейки наибольшего множителя кластера: 0 — кластеров не было, k ≥ 1 — от 2^(k−1) до 2^k − 1.
describe('MathStats: наибольший множитель кластера', () => {
  it('раунд без кластеров, раунд с ×1 и раунд с ×16 — в разных ячейках', () => {
    const stats = new StatsRecorder(TEST_CONFIG);
    const aggregate = new MathStats(TEST_CONFIG.capX100, TEST_CONFIG.sizeBands.length);
    const column = ['QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ'];
    const top = drops('base', ['...D...', '...D...', '...D...', '...D...', '...D...', '.......', '.......']);
    const rounds = [
      [fill('base', BACKGROUND)],
      [fill('base', ['QACESRQ', 'CESRQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ']), drops('base', ['...R...', '...A...', '...E...', '...R...', '...A...', '.......', '.......'])],
      [
        fill('base', column),
        drops('base', ['...E...', '...R...', '...D...', '...D...', '...D...', '...D...', '...D...']),
        top,
        top,
        drops('base', ['...R...', '...A...', '...E...', '...R...', '...A...', '.......', '.......']),
      ],
    ];
    const engine = new RoundEngine(TEST_CONFIG, new ScenarioSource(rounds.flat()), stats);
    rounds.forEach((_, seed) => {
      engine.play();
      aggregate.add(seed, stats, 0);
    });
    expect(Array.from(aggregate.toPlain().maxMult)).toStrictEqual([1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
