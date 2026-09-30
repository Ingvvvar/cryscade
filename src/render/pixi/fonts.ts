// Шрифты счётчиков и надписей (§9, §11): BitmapFont из Unbounded, установленный только после document.fonts.load —
// иначе глифы выпеклись бы запасным шрифтом. Кириллица Unbounded — отдельное подмножество (unicode-range): грузится,
// только когда load получает текст с ней, поэтому надписи грузятся со своим текстом. Шрифты ставятся один раз на
// страницу и не снимаются: их текстура, побывав в батче WebGPU, держится модульным кэшем Pixi (как источник атласа).

import { AbstractBitmapFont, BitmapFont, Cache, type CharData } from 'pixi.js';
import { glyphSet, missingGlyphs } from '../glyph-set.ts';
import type { NumberStyle } from '../number-layout.ts';

export const DIGITS_FONT = 'cryscade-digits';
export const LABELS_FONT = 'cryscade-labels';
const FACE = 'Unbounded Variable';
const SPEC = `700 64px "${FACE}"`;
/** Цифры, разделители (запятая, точка, неразрывный и узкий неразрывный пробелы, пробел) и знаки множителя. */
const DIGITS = ['0123456789', ',.', '\u00a0\u202f ', '\u00d7\u2212+'];

function install(name: string, chars: string[]): void {
  if (Cache.has(`${name}-bitmap`)) return;
  BitmapFont.install({
    name,
    chars,
    resolution: 2,
    padding: 4,
    style: { fontFamily: FACE, fontSize: 64, fontWeight: '700', fill: 0xffffff },
  });
}

/** Шрифт цифр готов: document.fonts видел Unbounded в момент установки. */
export async function ensureDigitsFont(): Promise<boolean> {
  await document.fonts.load(SPEC);
  const ready = document.fonts.check(SPEC);
  install(DIGITS_FONT, DIGITS);
  return ready;
}

/** Шрифт надписей по строкам сцены: грузится с их текстом (кириллица), набор глифов — из них же. */
export async function ensureLabelsFont(texts: readonly string[]): Promise<boolean> {
  const text = texts.join('');
  await document.fonts.load(SPEC, text);
  const ready = document.fonts.check(SPEC, text);
  install(LABELS_FONT, glyphSet(texts));
  return ready;
}

/** Установленный шрифт — DynamicBitmapFont, не BitmapFont (install его так и создаёт); до установки — ошибка вызывающего. */
export type InstalledFont = AbstractBitmapFont<unknown>;

export function installedFont(name: string): InstalledFont {
  const font: unknown = Cache.get(`${name}-bitmap`);
  if (!(font instanceof AbstractBitmapFont)) throw new Error(`шрифт ${name} не установлен`);
  return font;
}

/** Глифы шрифта по коду символа — для раскладки чисел без строк в кадре. */
export function glyphsByCode(font: InstalledFont): Map<number, CharData> {
  const glyphs = new Map<number, CharData>();
  for (const [char, data] of Object.entries(font.chars)) glyphs.set(char.charCodeAt(0), data);
  return glyphs;
}

/** Что сцена пишет шрифтом цифр: цифры, знаки множителя и ретриггера, разделители локали. */
export function digitTexts(style: NumberStyle): string[] {
  return ['0123456789', '\u00d7+', style.group, style.decimal];
}

/** Символы строк, которых нет в установленном шрифте. Пробел глифа-текстуры не имеет — он есть, если есть запись. */
export function fontMissing(name: string, texts: readonly string[]): string[] {
  const font = installedFont(name);
  return missingGlyphs(texts, (char) => font.chars[char] !== undefined);
}
