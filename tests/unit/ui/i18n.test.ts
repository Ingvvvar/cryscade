import { describe, expect, it } from 'vitest';
import { LANGUAGE_NAMES, LANGUAGES, type Dictionary } from '../../../src/ui/i18n/dictionary.ts';
import { EN } from '../../../src/ui/i18n/en.ts';
import { UK } from '../../../src/ui/i18n/uk.ts';

// Словари (§11, решение 8 фазы 7): одинаковый набор ключей в uk и en — построчно, на любой глубине; пустых строк нет.

/** Пути всех листьев словаря: «text.spin», «refusal.INVALID_BET». */
function leaves(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, inner]) => leaves(inner, prefix === '' ? key : `${prefix}.${key}`));
}

function strings(dict: Dictionary): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
    else if (typeof value === 'object' && value !== null) for (const inner of Object.values(value)) walk(inner);
  };
  walk(dict);
  return out;
}

describe('словари', () => {
  it('uk и en: те же ключи на любой глубине', () => {
    const uk = leaves(UK).sort();
    expect(uk.length).toBeGreaterThan(40);
    expect(leaves(EN).sort()).toStrictEqual(uk);
  });

  it('языки и локали сумм', () => {
    expect(LANGUAGES).toStrictEqual(['uk', 'en']);
    expect([UK.language, UK.locale, EN.language, EN.locale]).toStrictEqual(['uk', 'uk-UA', 'en', 'en-GB']);
    expect(LANGUAGE_NAMES).toStrictEqual({ uk: 'Українська', en: 'English' });
  });

  it('пустых строк нет; английский — не украинский', () => {
    const uk = strings(UK);
    const en = strings(EN);
    expect(uk.length).toBeGreaterThan(40);
    expect([...uk, ...en].filter((text) => text.trim() === '')).toStrictEqual([]);
    expect(en.filter((text) => /[а-яіїєґ]/i.test(text))).toStrictEqual([]);
  });

  it('литералы: подписи панели на обоих языках', () => {
    expect([UK.text.spin, UK.text.balance, UK.text.settings, EN.text.spin, EN.text.balance, EN.text.settings]).toStrictEqual([
      'Спін',
      'Баланс',
      'Налаштування',
      'Spin',
      'Balance',
      'Settings',
    ]);
  });
});
