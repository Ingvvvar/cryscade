import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../../src/core/jurisdiction.ts';

// §1.6: правила юрисдикции — данными; код читает флаги пресета, а не его имя. Сторож (аудит фазы 9): в src/ нет
// сравнения с именем пресета — ни ===, !==, ==, != со строкой-именем, ни case с ним. Подпись пресета — ключ словаря по
// имени (settings-dialog.tsx), а не ветка по имени. Сначала контроль: подброшенные сравнения находятся.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const NAMES = new Set<string>(Object.keys(PRESETS));
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = path.posix.join(dir, entry);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

/** `файл:строка` каждого сравнения с именем пресета. */
function presetComparisons(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const isName = (node: ts.Node): boolean => ts.isStringLiteralLike(node) && NAMES.has(node.text);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const compared = ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind) && (isName(node.left) || isName(node.right));
    if (compared || (ts.isCaseClause(node) && isName(node.expression))) {
      found.push(`${file}:${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('имя пресета не сравнивается (§1.6)', () => {
  it('контроль: ===, !== и case с именем находятся; имя в данных и чужая строка — нет', () => {
    const text = [
      "const a = preset === 'strict';",
      "const b = 'standard' !== name;",
      'switch (name) {',
      "  case 'strict':",
      '    break;',
      '}',
      "const order = ['standard', 'strict'];",
      "const labels = { standard: 'presetStandard', strict: 'presetStrict' };",
      "const c = speed === 'turbo';",
    ].join('\n');
    expect(presetComparisons('src/x.tsx', text)).toStrictEqual(['src/x.tsx:1', 'src/x.tsx:2', 'src/x.tsx:4']);
  });

  it('src/: сравнений с именем пресета нет', () => {
    expect([...NAMES].sort()).toStrictEqual(['standard', 'strict']);
    const files = walk('src');
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap((file) => presetComparisons(file, readFileSync(path.join(ROOT, file), 'utf8')))).toStrictEqual([]);
  });
});
