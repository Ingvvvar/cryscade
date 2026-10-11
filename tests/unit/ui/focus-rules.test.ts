import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Сторож рамки фокуса (§11, прогон №6): в CSS игры нет правил на :focus без -visible и -within — рамка только с
// клавиатуры, от касания её нет. Правило последнего ввода (рамки нет после касания и мыши) — последнее в styles.css:
// перебивает рамки выше при любой их специфичности, равной его.

/** Прелюдии правил: селекторы и @-правила, без комментариев. */
function preludes(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/([^{};]+)\{/g)].map((match) => (match[1] ?? '').replace(/\s+/g, ' ').trim());
}

/** Селекторы с :focus без -visible и -within: такая рамка горит от любого фокуса, и от касания тоже. */
function plainFocus(css: string): string[] {
  return preludes(css).filter((prelude) => !prelude.startsWith('@') && /:focus(?![\w-])/.test(prelude));
}

/** Все .css в src/ — их грузит игра. */
function sources(): { readonly path: string; readonly text: string }[] {
  return readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.css'))
    .map((path) => ({ path: join('src', path), text: readFileSync(join('src', path), 'utf8') }));
}

const SUPPRESSION = ":root[data-input='pointer'] :focus-visible";

describe('сторож рамки фокуса', () => {
  it('положительный контроль: ловит :focus в любом месте селектора и пропускает :focus-visible и :focus-within', () => {
    const css = [
      '/* .comment:focus { outline: none } */',
      '.a:focus { outline: 2px solid red; }',
      '.b, .c:focus-visible { outline: 3px solid; }',
      '@media (hover: none) { .d:focus:not(:focus-visible), .e { outline: none; } }',
      ':is(.f:focus) { box-shadow: 0 0 0 2px; }',
      '.g:focus-within { outline: 1px solid; }',
      '.h:focus-visible { outline: none; }',
      '.i:focus',
      '{ color: red; }',
    ].join('\n');
    expect(plainFocus(css)).toStrictEqual(['.a:focus', '.d:focus:not(:focus-visible), .e', ':is(.f:focus)', '.i:focus']);
  });

  it('в CSS игры нет :focus без -visible и -within; файлы и правила найдены, рамки на :focus-visible есть', () => {
    const files = sources();
    expect(files.map((file) => file.path)).toContain('src/ui/styles.css');
    const all = files.flatMap((file) => preludes(file.text).map((prelude) => `${file.path}: ${prelude}`));
    expect(all.length).toBeGreaterThan(100);
    expect(all.filter((prelude) => prelude.includes(':focus-visible')).length).toBeGreaterThan(4);
    expect(files.flatMap((file) => plainFocus(file.text).map((selector) => `${file.path}: ${selector}`))).toStrictEqual([]);
  });

  it('правило последнего ввода — последнее в styles.css и снимает рамку', () => {
    const css = readFileSync('src/ui/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((match) => ({ selector: (match[1] ?? '').trim(), body: (match[2] ?? '').trim() }));
    expect(rules.length).toBeGreaterThan(100);
    expect(rules.at(-1)).toStrictEqual({ selector: SUPPRESSION, body: 'outline: none;' });
  });
});
