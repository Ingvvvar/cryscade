import { describe, expect, it } from 'vitest';
import { isAscendingInts, isIntIn, isNat, isPositive, isRecord, isToken } from '../../../src/protocol/index.ts';

// Кирпичи гардов: границы литералами.

describe('кирпичи гардов', () => {
  it('isRecord: объект, но не массив и не null', () => {
    expect([isRecord({}), isRecord(Object.create(null)), isRecord(new Map())]).toStrictEqual([true, true, true]);
    expect([isRecord([]), isRecord(null), isRecord('x'), isRecord(1)]).toStrictEqual([false, false, false, false]);
  });

  it('isNat: безопасное целое от нуля', () => {
    expect([0, 1, Number.MAX_SAFE_INTEGER].map(isNat)).toStrictEqual([true, true, true]);
    expect([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, '1', 1n].map(isNat)).toStrictEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('isPositive: безопасное целое от единицы', () => {
    expect([1, Number.MAX_SAFE_INTEGER].map(isPositive)).toStrictEqual([true, true]);
    expect([0, -1, 1.5].map(isPositive)).toStrictEqual([false, false, false]);
  });

  it('isIntIn: целое в границах включительно', () => {
    expect([isIntIn(0, 0, 7), isIntIn(7, 0, 7), isIntIn(-1, 0, 7), isIntIn(8, 0, 7), isIntIn(3.5, 0, 7), isIntIn('3', 0, 7)]).toStrictEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('isToken: от 1 до 64 знаков [0-9A-Za-z_-]', () => {
    expect(['a', 'A-z_09', 'x'.repeat(64), '550e8400-e29b-41d4-a716-446655440000'].map(isToken)).toStrictEqual([true, true, true, true]);
    expect(['', 'x'.repeat(65), 'a b', 'ключ', 'a.b', 'a/b', 1, null].map(isToken)).toStrictEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('isAscendingInts: строго по возрастанию, в границах', () => {
    expect([isAscendingInts([], 0, 48), isAscendingInts([0, 1, 48], 0, 48)]).toStrictEqual([true, true]);
    expect([
      isAscendingInts([1, 1], 0, 48),
      isAscendingInts([2, 1], 0, 48),
      isAscendingInts([0, 49], 0, 48),
      isAscendingInts([-1], 0, 48),
      isAscendingInts([0.5], 0, 48),
      isAscendingInts('01', 0, 48),
    ]).toStrictEqual([false, false, false, false, false, false]);
  });
});
