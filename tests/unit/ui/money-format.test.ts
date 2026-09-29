import { describe, expect, it } from 'vitest';
import { MoneyFormat } from '../../../src/ui/money-format.ts';

// Суммы из минимальных единиц: литералы, включая суммы, где деление на 100 с плавающей точкой ошиблось бы.

describe('MoneyFormat uk-UA', () => {
  const money = new MoneyFormat('uk-UA');

  it.each([
    [0, '0,00'],
    [5, '0,05'],
    [35, '0,35'],
    [100_000, '1 000,00'],
    [99_935, '999,35'],
    [123_456_789, '1 234 567,89'],
    // 2^53 − 1: деление на 100 с плавающей точкой дало бы целую часть на единицу больше.
    [9_007_199_254_740_991, '90 071 992 547 409,91'],
  ])('%d → %s', (minor, text) => {
    expect(money.format(minor)).toBe(text);
  });

  it('контроль: формат суммы, делённой на 100, на той же сумме ошибается — литерал выше различает', () => {
    const naive = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(naive.format(9_007_199_254_740_899 / 100)).toBe('90\u00a0071\u00a0992\u00a0547\u00a0408,98');
  });
});
