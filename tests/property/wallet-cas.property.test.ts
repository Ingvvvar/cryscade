import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { walletProperty, zeroTotals } from '../support/wallet-world.ts';

// Сверка кошелька (§14), замок подвёл: замок без исключения, обе вкладки пишут одновременно — деньги держит CAS
// по ревизии кошелька внутри транзакции. Те же сверки, что в wallet.property.test.ts.

describe('сверка кошелька: замок подвёл', () => {
  it('запись держит CAS: деньги сходятся, починки без порчи нет', async () => {
    const totals = zeroTotals();
    await fc.assert(walletProperty(false, totals), { numRuns: 300 });
    // Без исключения записи обязаны сталкиваться: иначе CAS не проверен.
    expect(totals.conflicts).toBeGreaterThan(0);
    expect(totals.replays).toBeGreaterThan(0);
    expect(totals.takeovers).toBeGreaterThan(0);
    expect(totals.commits).toBeGreaterThan(0);
  }, 60_000);
});
