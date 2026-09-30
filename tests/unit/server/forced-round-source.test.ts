import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import type { PlayResult, ResponseBody } from '../../../src/protocol/index.ts';
import { ForcedRoundSource } from '../../../src/server/forced-round-source.ts';
import { MemoryLock, MemoryStorage, RgsServer, type RoundDraw, type RoundSource } from '../../../src/server/index.ts';
import { SeededRounds } from '../../../src/server/seeded-rounds.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';
import { BroadcastLog, FixedClock, ScriptedEntropy, T0 } from '../../support/rgs-rig.ts';

// Принудительный раунд (dev и e2e, фаза 5): Strategy-декоратор над источником раундов. Ожидания — записанные фикстуры:
// сид фикстуры даёт её события и итог. Деньги идут обычным путём — проверка на сервере в памяти.

class CountingSource implements RoundSource {
  draws = 0;

  draw(): RoundDraw {
    this.draws += 1;
    return { seed: 0, ...new SeededRounds(DEFAULT_CONFIG, 100_000).play(0) };
  }
}

describe('ForcedRoundSource', () => {
  it('без сида — живой источник; сид — раунд этого сида один раз, дальше снова живой', () => {
    const live = new CountingSource();
    const forced = new ForcedRoundSource(live, new SeededRounds(DEFAULT_CONFIG, 100_000));
    expect(forced.draw().seed).toBe(0);
    expect(live.draws).toBe(1);
    const feature = fixtureRound('feature-start');
    forced.force(feature.seed);
    expect(forced.draw()).toStrictEqual({ seed: 48, payX100: feature.payX100, events: feature.events });
    expect(live.draws).toBe(1);
    forced.draw();
    expect(live.draws).toBe(2);
  });

  it('на сервере: принудительный раунд списывает ставку и зачисляет выигрыш обычным путём', async () => {
    const storage = new MemoryStorage({ durable: true });
    const holder: { forced: ForcedRoundSource | null } = { forced: null };
    const server = new RgsServer(
      { storage, lock: new MemoryLock(), clock: new FixedClock(T0), entropy: new ScriptedEntropy([0]), broadcast: new BroadcastLog(storage) },
      {
        config: DEFAULT_CONFIG,
        decorateSource: (live, rounds) => {
          holder.forced = new ForcedRoundSource(live, rounds);
          return holder.forced;
        },
      },
    );
    await server.handle({ v: 1, id: 1, body: { type: 'authenticate' } });
    holder.forced?.force(fixtureRound('multiplier-8').seed);
    const played = (await server.handle({ v: 1, id: 2, body: { type: 'play', betMinor: 100, idempotencyKey: 'k1' } })).body as ResponseBody<PlayResult>;
    if (!played.ok) throw new Error('play отказан');
    expect(played.result.balanceMinor).toBe(99_900);
    expect([played.result.round.payX100, played.result.round.winMinor]).toStrictEqual([1500, 1500]);
    expect(played.result.round.events).toStrictEqual(fixtureRound('multiplier-8').events);
    const ended = (await server.handle({ v: 1, id: 3, body: { type: 'endRound', roundId: played.result.round.roundId } })).body;
    expect(ended).toMatchObject({ ok: true, result: { balanceMinor: 99_900 + 1500 } });
  });
});
