import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_GLYPHS, layoutInteger, layoutMoney, numberCodes } from '../../../src/render/number-layout.ts';
import { MoneyFormat } from '../../../src/ui/money-format.ts';

// Раскладка суммы для счётчиков Pixi: целой арифметикой в буфер кодов. Ожидание — строка Intl через MoneyFormat
// (независимое вычисление: Intl против своей целой арифметики) и литералы.

const text = (out: Uint16Array, length: number): string => String.fromCharCode(...out.subarray(0, length));

function money(minor: number, locale: string): string {
  const out = new Uint16Array(MAX_GLYPHS);
  return text(out, layoutMoney(minor, numberCodes(new MoneyFormat(locale).style), out));
}

describe('layoutMoney', () => {
  it.each([
    [0, '0,00'],
    [5, '0,05'],
    [99_935, '999,35'],
    [99_999, '999,99'],
    [100_000, '1\u00a0000,00'],
    [123_456_789, '1\u00a0234\u00a0567,89'],
    [9_007_199_254_740_991, '90\u00a0071\u00a0992\u00a0547\u00a0409,91'],
    // Деление на 100 с плавающей точкой дало бы здесь …409,00 вместо …408,99 (тот же литерал, что у MoneyFormat).
    [9_007_199_254_740_899, '90\u00a0071\u00a0992\u00a0547\u00a0408,99'],
  ])('uk-UA: %d → %s', (minor, expected) => {
    expect(money(minor, 'uk-UA')).toBe(expected);
  });

  it('pl-PL: группировка с 10 000, не с 1000 (минимум группировки 2)', () => {
    expect(money(100_000, 'pl-PL')).toBe('1000,00');
    expect(money(1_000_000, 'pl-PL')).toBe('10\u00a0000,00');
  });

  it('en-US: запятая разрядов, точка дроби', () => {
    expect(money(123_456_789, 'en-US')).toBe('1,234,567.89');
  });

  it.each(['uk-UA', 'en-US', 'pl-PL', 'fr-FR', 'de-DE', 'es-ES'])('%s: совпадает с MoneyFormat на любой безопасной сумме', (locale) => {
    const format = new MoneyFormat(locale);
    const codes = numberCodes(format.style);
    const out = new Uint16Array(MAX_GLYPHS);
    fc.assert(
      fc.property(fc.oneof(fc.integer({ min: 0, max: 1_000_000_000 }), fc.maxSafeNat()), (minor) => {
        expect(text(out, layoutMoney(minor, codes, out))).toBe(format.format(minor));
      }),
      { numRuns: 2000 },
    );
  });

  it('длиннейшая сумма помещается в буфер', () => {
    const out = new Uint16Array(MAX_GLYPHS);
    expect(layoutMoney(Number.MAX_SAFE_INTEGER, numberCodes(new MoneyFormat('uk-UA').style), out)).toBeLessThanOrEqual(MAX_GLYPHS);
  });

  it('дробная, отрицательная и небезопасная сумма — ошибка, а не мусор на экране', () => {
    const codes = numberCodes(new MoneyFormat('uk-UA').style);
    const out = new Uint16Array(MAX_GLYPHS);
    for (const bad of [1.5, -1, 2 ** 53, Number.NaN]) expect(() => layoutMoney(bad, codes, out)).toThrow(RangeError);
  });

  it('разделитель — ровно один символ', () => {
    expect(() => numberCodes({ group: '', decimal: ',', groupFrom: 1000 })).toThrow(RangeError);
    expect(() => numberCodes({ group: ' ', decimal: ',.', groupFrom: 1000 })).toThrow(RangeError);
    expect(() => numberCodes({ group: ' ', decimal: ',', groupFrom: 0 })).toThrow(RangeError);
  });
});

describe('layoutInteger', () => {
  it.each([
    [0, -1, '0'],
    [7, -1, '7'],
    [10, -1, '10'],
    [5, 43, '+5'],
    [128, 0xd7, '\u00d7128'],
    [1234567, -1, '1234567'],
  ])('%d с приставкой %d → %s', (value, prefix, expected) => {
    const out = new Uint16Array(MAX_GLYPHS);
    expect(text(out, layoutInteger(value, prefix, out))).toBe(expected);
  });
});
