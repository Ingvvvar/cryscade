import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { walletProperty, zeroTotals } from '../support/wallet-world.ts';

// Сверка кошелька (§14), замок держит: две вкладки на общем хранилище и общем замке, потери, дубли, перемежения.
// Что сверяется — в tests/support/wallet-world.ts.

describe('сверка кошелька: замок держит', () => {
  it('деньги сходятся до минимальной единицы после каждой записи; конфликтов и INTERNAL нет', async () => {
    const totals = zeroTotals();
    await fc.assert(walletProperty(true, totals), { numRuns: 300 });
    // Покрытие: прогон обязан пройти через повторы, перехваты, восстановление, сбросы, нехватку средств, потери
    // и дубли — иначе он проверил не всё.
    expect(totals.replays).toBeGreaterThan(0);
    expect(totals.takeovers).toBeGreaterThan(0);
    expect(totals.restored).toBeGreaterThan(0);
    expect(totals.resets).toBeGreaterThan(0);
    expect(totals.funds).toBeGreaterThan(0);
    expect(totals.timeouts).toBeGreaterThan(0);
    expect(totals.duplicates).toBeGreaterThan(0);
    expect(totals.commits).toBeGreaterThan(0);
  }, 60_000);
});
