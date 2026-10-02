import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { SERVER_MAX_REQUESTS } from '../../../src/server/limits.ts';
import { BookRoundSource, LiveRoundSource } from '../../../src/server/round-source.ts';
import { SeededRounds } from '../../../src/server/seeded-rounds.ts';
import { NodeCrypto } from '../../support/node-crypto.ts';
import { ScriptedEntropy } from '../../support/rgs-rig.ts';
import { testBook } from '../../support/test-book.ts';

// Источники раундов (§3, Strategy) без сервера: книга без состояния честности не выбирает и не отдаёт запись, которая
// разошлась с движком; живой источник помечает раунд live с пустыми полями честности. Итоги сидов — из фикстур:
// сид 0 — small-win, 0.95×.

const CONTEXT = { secret: 'ab'.repeat(32), commitment: 'cd'.repeat(32), clientSeed: 'player1', nonce: 0 };

describe('BookRoundSource', () => {
  it('без состояния честности — ошибка, а не выбор', async () => {
    const source = new BookRoundSource(() => testBook(), new NodeCrypto(), new SeededRounds(DEFAULT_CONFIG, SERVER_MAX_REQUESTS));
    await expect(source.draw(null)).rejects.toThrow(new Error('книга: нет состояния честности'));
  });

  it('запись разошлась с движком — ошибка с записью, сидом и обоими итогами', async () => {
    // Одна запись: любое значение HMAC попадает в неё. Движок на сиде 0 даёт 95, в книге — 96.
    const book = testBook([{ seed: 0, payX100: 96, weight: 1 }]);
    const source = new BookRoundSource(() => book, new NodeCrypto(), new SeededRounds(DEFAULT_CONFIG, SERVER_MAX_REQUESTS));
    await expect(source.draw(CONTEXT)).rejects.toThrow(new Error('книга и движок разошлись: запись 0, сид 0 — 95, в книге 96'));
  });
});

describe('LiveRoundSource', () => {
  it('сид — из энтропии, раунд — движок по нему; честности нет: live и пустые поля', async () => {
    const draw = await new LiveRoundSource(new ScriptedEntropy([0]), new SeededRounds(DEFAULT_CONFIG, SERVER_MAX_REQUESTS)).draw();
    expect([draw.seed, draw.payX100, draw.fairness]).toStrictEqual([0, 95, { source: 'live', bookIndex: null, nonce: null, commitment: null, clientSeed: null }]);
  });
});
