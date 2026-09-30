import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import type { PlayResult, ResponseBody } from '../../../src/protocol/index.ts';
import { ForcedRoundSource } from '../../../src/server/forced-round-source.ts';
import { MemoryLock, MemoryStorage, RgsServer, type FairnessContext, type RoundDraw, type RoundSource } from '../../../src/server/index.ts';
import { SeededRounds } from '../../../src/server/seeded-rounds.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';
import { BroadcastLog, FixedClock, ScriptedEntropy, T0 } from '../../support/rgs-rig.ts';
import { NodeCrypto } from '../../support/node-crypto.ts';

// Принудительный раунд (dev и e2e, фаза 5): Strategy-декоратор над источником раундов. Ожидания — записанные фикстуры:
// сид фикстуры даёт её события и итог. Деньги идут обычным путём — проверка на сервере в памяти.

const LIVE = { source: 'live', bookIndex: null, nonce: null, commitment: null, clientSeed: null } as const;

class CountingSource implements RoundSource {
  draws = 0;
  contexts: unknown[] = [];

  draw(fairness: FairnessContext | null): Promise<RoundDraw> {
    this.draws += 1;
    this.contexts.push(fairness);
    return Promise.resolve({ seed: 0, ...new SeededRounds(DEFAULT_CONFIG, 100_000).play(0), fairness: LIVE });
  }
}

const CONTEXT: FairnessContext = { secret: '00'.repeat(32), commitment: 'ab'.repeat(32), clientSeed: 'seed', nonce: 7 };

describe('ForcedRoundSource', () => {
  it('без сида — источник под ним с тем же контекстом честности; сид — раунд этого сида один раз, помечен forced', async () => {
    const live = new CountingSource();
    const forced = new ForcedRoundSource(live, new SeededRounds(DEFAULT_CONFIG, 100_000));
    expect((await forced.draw(CONTEXT)).seed).toBe(0);
    expect([live.draws, live.contexts]).toStrictEqual([1, [CONTEXT]]);
    const feature = fixtureRound('feature-start');
    forced.force(feature.seed);
    expect(await forced.draw(CONTEXT)).toStrictEqual({
      seed: 48,
      payX100: feature.payX100,
      events: feature.events,
      fairness: { source: 'forced', bookIndex: null, nonce: null, commitment: null, clientSeed: null },
    });
    expect(live.draws).toBe(1);
    await forced.draw(null);
    expect(live.draws).toBe(2);
  });

  it('на сервере: принудительный раунд списывает ставку и зачисляет выигрыш обычным путём', async () => {
    const storage = new MemoryStorage({ durable: true });
    const holder: { forced: ForcedRoundSource | null } = { forced: null };
    const server = new RgsServer(
      { storage, lock: new MemoryLock(), clock: new FixedClock(T0), entropy: new ScriptedEntropy([0]), broadcast: new BroadcastLog(storage), crypto: new NodeCrypto() },
      {
        config: DEFAULT_CONFIG,
        rounds: { kind: 'live' },
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
