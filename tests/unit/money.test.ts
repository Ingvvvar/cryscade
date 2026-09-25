import { describe, expect, it } from 'vitest';
import { BET_LEVELS_MINOR, MINOR_PER_CREDIT, START_BALANCE_MINOR, isBetLevel, winMinor } from '../../src/core/money.ts';

describe('winMinor = floor(bet × payX100 / 100)', () => {
  it.each([
    // [ставка в минимальных единицах, payX100, выигрыш]
    [20, 25, 5], // 0.20 × 0.25× = 0.05
    [20, 33, 6], // 0.20 × 0.33× = 0.066 → 0.06
    [40, 1, 0], // 0.40 × 0.01× = 0.004 → 0
    [100, 199, 199], // 1.00 × 1.99× = 1.99, дробной части нет
    [1, 199, 1], // 0.01 × 1.99× = 0.0199 → 0.01: дробь отбрасывается
    [10000, 500000, 50_000_000], // 100 кредитов × 5000× = 500 000 кредитов
    [20, 0, 0],
    [0, 500000, 0],
  ])('bet %i × payX100 %i → %i', (bet, payX100, expected) => {
    expect(winMinor(bet, payX100)).toBe(expected);
  });

  it.each([
    [1.5, 100],
    [-1, 100],
    [100, -1],
    [100, 0.5],
    [Number.NaN, 100],
    [100, Number.POSITIVE_INFINITY],
    [2 ** 53, 1],
  ])('bet %s, payX100 %s — RangeError', (bet, payX100) => {
    expect(() => winMinor(bet, payX100)).toThrow(RangeError);
  });

  it('произведение вне 2^53 — RangeError, а не молча неточное число', () => {
    expect(() => winMinor(10000, 2 ** 50)).toThrow(RangeError);
  });
});

describe('ставки и баланс §4.6', () => {
  it('ставки 0.20, 0.40, 1, 2, 4, 10, 20, 50, 100 кредитов', () => {
    expect(BET_LEVELS_MINOR).toEqual([20, 40, 100, 200, 400, 1000, 2000, 5000, 10000]);
  });

  it('стартовый баланс — 1000 кредитов, кредит — 100 минимальных единиц', () => {
    expect(START_BALANCE_MINOR).toBe(100_000);
    expect(MINOR_PER_CREDIT).toBe(100);
  });

  it.each([
    [20, true],
    [10000, true],
    [0, false],
    [30, false],
    [20.5, false],
    [20000, false],
  ])('isBetLevel(%s) = %s', (bet, expected) => {
    expect(isBetLevel(bet)).toBe(expected);
  });
});
