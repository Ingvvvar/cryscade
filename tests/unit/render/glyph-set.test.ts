import { describe, expect, it } from 'vitest';
import { glyphSet, missingGlyphs } from '../../../src/render/glyph-set.ts';
import { sceneTextList } from '../../../src/render/renderer.ts';
import { SCENE_TEXTS } from '../../../src/ui/scene-texts.ts';

// Набор глифов шрифта надписей — из строк сцены (§9): уникальные символы по возрастанию кода. Недостающие —
// символы строк, которых шрифт не знает; настоящий шрифт проверяет tests/gpu/presentation.spec.ts.

describe('glyphSet', () => {
  it('уникальные символы всех строк по возрастанию кода, пробел — тоже символ', () => {
    expect(glyphSet(['баба', 'аб в'])).toStrictEqual([' ', 'а', 'б', 'в']);
  });

  it('суррогатная пара — один символ, а не две половины', () => {
    expect(glyphSet(['a\u{1F48E}b'])).toStrictEqual(['a', 'b', '\u{1F48E}']);
  });

  it('надписи сцены обоих языков: все символы строк ui, кириллица и латиница в наборе', () => {
    const texts = [...sceneTextList(SCENE_TEXTS.uk), ...sceneTextList(SCENE_TEXTS.en)];
    const set = glyphSet(texts);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) for (const char of text) expect(set).toContain(char);
    expect(set).toEqual(expect.arrayContaining(['Ф', 'і', 'щ', 'ж', 'F', 'T', 'w', 'x']));
  });

  it('надпись ретриггера с числом: в наборе все цифры, «+» и все формы слова', () => {
    const texts = sceneTextList(SCENE_TEXTS.uk);
    expect(texts).toEqual(expect.arrayContaining(['Фріспіни', 'Натисніть, щоб продовжити', 'Максимальний виграш', 'Великий виграш', 'Епічний виграш']));
    expect(texts).toEqual(expect.arrayContaining(['+1 фріспін', '+2 фріспіни', '+5 фріспінів', '+21 фріспін', '+99 фріспінів']));
    expect(glyphSet(texts)).toEqual(expect.arrayContaining(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+']));
  });
});

describe('missingGlyphs', () => {
  it('символы, которых нет в шрифте, — каждый один раз, по возрастанию кода', () => {
    const known = new Set(['а', 'б']);
    expect(missingGlyphs(['вба', 'гв'], (char) => known.has(char))).toStrictEqual(['в', 'г']);
    expect(missingGlyphs(['аб'], (char) => known.has(char))).toStrictEqual([]);
  });
});
