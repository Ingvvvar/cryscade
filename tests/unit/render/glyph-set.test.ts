import { describe, expect, it } from 'vitest';
import { glyphSet, missingGlyphs } from '../../../src/render/glyph-set.ts';
import { sceneTextList } from '../../../src/render/renderer.ts';
import { SCENE_TEXT } from '../../../src/ui/texts.ts';

// Набор глифов шрифта надписей — из строк сцены (§9): уникальные символы по возрастанию кода. Недостающие —
// символы строк, которых шрифт не знает; настоящий шрифт проверяет tests/gpu/presentation.spec.ts.

describe('glyphSet', () => {
  it('уникальные символы всех строк по возрастанию кода, пробел — тоже символ', () => {
    expect(glyphSet(['баба', 'аб в'])).toStrictEqual([' ', 'а', 'б', 'в']);
  });

  it('суррогатная пара — один символ, а не две половины', () => {
    expect(glyphSet(['a\u{1F48E}b'])).toStrictEqual(['a', 'b', '\u{1F48E}']);
  });

  it('надписи сцены: все символы строк ui и кириллица в наборе', () => {
    const texts = sceneTextList(SCENE_TEXT);
    expect(texts).toHaveLength(8);
    const set = glyphSet(texts);
    for (const text of texts) for (const char of text) expect(set).toContain(char);
    expect(set).toEqual(expect.arrayContaining(['Ф', 'і', 'щ', 'ж']));
  });
});

describe('missingGlyphs', () => {
  it('символы, которых нет в шрифте, — каждый один раз, по возрастанию кода', () => {
    const known = new Set(['а', 'б']);
    expect(missingGlyphs(['вба', 'гв'], (char) => known.has(char))).toStrictEqual(['в', 'г']);
    expect(missingGlyphs(['аб'], (char) => known.has(char))).toStrictEqual([]);
  });
});
