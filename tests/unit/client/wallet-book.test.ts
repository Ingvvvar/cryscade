import { describe, expect, it } from 'vitest';
import { WalletBook, type WalletUpdate } from '../../../src/client/index.ts';

// Порядок баланса по revision (§6.3): принимается только более новое; notice 'reset' — без сравнения.

const at = (revision: number, balanceMinor: number, notice: 'reset' | null = null): WalletUpdate => ({ balanceMinor, revision, notice });

describe('WalletBook', () => {
  it('до первого состояния баланс не известен; первое принимается любым', () => {
    const book = new WalletBook();
    expect(book.balanceMinor).toBeNull();
    expect(book.apply(at(7, 99_900))).toBe(true);
    expect(book.balanceMinor).toBe(99_900);
  });

  it('старее и той же ревизии — отбрасывается, новее — принимается', () => {
    const book = new WalletBook();
    book.apply(at(2, 99_935));
    expect([book.apply(at(1, 99_900)), book.apply(at(2, 1)), book.balanceMinor]).toStrictEqual([false, false, 99_935]);
    expect([book.apply(at(3, 99_835)), book.balanceMinor]).toStrictEqual([true, 99_835]);
  });

  it('свой ответ раньше своего оповещения: позднее оповещение play не откатывает баланс после endRound', () => {
    const book = new WalletBook();
    const seen = [at(0, 100_000), at(1, 99_900), at(2, 99_935), at(1, 99_900), at(2, 99_935)].map((update) => {
      book.apply(update);
      return book.balanceMinor;
    });
    expect(seen).toStrictEqual([100_000, 99_900, 99_935, 99_935, 99_935]);
  });

  it('reset — без сравнения и с новой точкой отсчёта: после починки ревизия начинается заново', () => {
    const book = new WalletBook();
    book.apply(at(57, 12_345));
    expect(book.apply(at(1, 100_000, 'reset'))).toBe(true);
    expect(book.apply(at(2, 99_900))).toBe(true);
    expect(book.apply(at(1, 100_000))).toBe(false);
    expect(book.balanceMinor).toBe(99_900);
  });
});
