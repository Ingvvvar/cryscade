import { describe, expect, it } from 'vitest';
import { SUPERCRITICAL_CONFIG } from '../../support/configs.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';
import { Rig } from '../../support/rgs-rig.ts';

// Сторож сервера (§4.7): движок считается до транзакции, поэтому сработавший сторож — INTERNAL с сидом и ни одной
// записи; повтор с тем же ключом идёт с новым сидом. Порог 50: fill — 49 запросов, любой каскад его перешагнёт.

describe('сторож сервера', () => {
  it('по умолчанию порог — 100 000 запросов: надкритичная фича падает на нём, а не висит', async () => {
    const rig = new Rig({ seeds: [12345], config: SUPERCRITICAL_CONFIG });
    const tripped = await rig.send({ type: 'play', betMinor: 100, idempotencyKey: 'k1' });
    expect(!tripped.ok && tripped.error).toStrictEqual({
      code: 'INTERNAL',
      message: 'сторож: раунд с сидом 12345 сделал больше 100000 запросов к источнику — фича надкритична или каскад бесконечен',
    });
  });

  it('сработал — INTERNAL с сидом, хранилище не тронуто, оповещений нет; повтор тем же ключом — новый сид', async () => {
    const rig = new Rig({ seeds: [0, 1], maxRequests: 50 });
    const tripped = await rig.send({ type: 'play', betMinor: 100, idempotencyKey: 'k1' });
    expect(tripped.ok).toBe(false);
    if (tripped.ok) return;
    expect(tripped.error.code).toBe('INTERNAL');
    expect(tripped.error.code === 'INTERNAL' && tripped.error.message).toContain('раунд с сидом 0 сделал больше 50 запросов');
    expect(rig.storage.snapshot()).toStrictEqual({ wallet: [], rounds: [], keys: [], quarantine: [] });
    expect(rig.broadcast.messages).toStrictEqual([]);

    expect(await rig.send({ type: 'play', betMinor: 100, idempotencyKey: 'k1' })).toStrictEqual({
      ok: true,
      result: { round: { roundId: 'r1', betMinor: 100, payX100: 0, winMinor: 0, events: fixtureRound('loss').events }, balanceMinor: 99_900 },
    });
  });
});
