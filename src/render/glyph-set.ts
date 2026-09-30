// Набор глифов BitmapFont надписей (§9): из строк сцены, которые присылает ui, — в render/ текста нет. Без Pixi:
// набор и недостающие глифы проверяются и в Node, и на настоящем шрифте в браузере.

/** Уникальные символы строк по возрастанию кода; суррогатные пары — одним символом. */
export function glyphSet(texts: readonly string[]): string[] {
  const chars = new Set<string>();
  for (const text of texts) for (const char of text) chars.add(char);
  return [...chars].sort((a, b) => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0));
}

/** Символы строк, которых нет в шрифте; каждый — один раз, по возрастанию кода. */
export function missingGlyphs(texts: readonly string[], has: (char: string) => boolean): string[] {
  return glyphSet(texts).filter((char) => !has(char));
}
