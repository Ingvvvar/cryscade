import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { isPropertyName } from '../boundaries/core-globals.ts';
import { scanRepo } from '../boundaries/graph.ts';

// Выигрыш раунда на сервере считает только winMinor (§4.6), и зовут её в одном месте — RgsServer.#price. Формулу
// закрепляет tests/unit/money.test.ts, место — этот скан: одна ссылка на winMinor на весь server/, это вызов, он
// в #price, и нигде нет умножения или деления с payX100 — второго, самодельного расчёта.

interface Reference {
  readonly line: number;
  readonly call: boolean;
  /** Класс.метод или функция, где стоит ссылка; null — верхний уровень модуля. */
  readonly owner: string | null;
}

const ARITHMETIC = new Set([
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
]);

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function memberName(node: ts.Node): string | null {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return node.name.getText();
  return null;
}

function ownerOf(node: ts.Node): string | null {
  for (let at = node.parent; !ts.isSourceFile(at); at = at.parent) {
    const method = memberName(at);
    if (method !== null && ts.isClassLike(at.parent)) return `${at.parent.name?.text ?? '<класс>'}.${method}`;
    if (ts.isFunctionDeclaration(at)) return at.name?.text ?? '<функция>';
  }
  return null;
}

const isMoney = (specifier: ts.Expression | undefined): boolean =>
  specifier !== undefined && ts.isStringLiteral(specifier) && /(^|\/)core\/money\.ts$/.test(specifier.text);

/**
 * Ссылки на функцию winMinor из core/money.ts: по имени, под которым файл её импортировал (в том числе через as),
 * через namespace-импорт money и реэкспорт. Локальная переменная с тем же именем, но без импорта — не ссылка.
 */
function winMinorReferences(fileName: string, text: string): Reference[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const found: Reference[] = [];
  const add = (node: ts.Node, call: boolean): void => {
    found.push({ line: lineOf(source, node), call, owner: ownerOf(node) });
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && isMoney(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).getText(source) === 'winMinor') names.add(element.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(statement) && isMoney(statement.moduleSpecifier)) {
      const clause = statement.exportClause;
      const named =
        clause !== undefined &&
        ts.isNamedExports(clause) &&
        clause.elements.some((element) => (element.propertyName ?? element.name).getText(source) === 'winMinor');
      if (clause === undefined || named) add(statement, false);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    const parent = node.parent;
    if (ts.isIdentifier(node) && names.has(node.text) && !isPropertyName(node)) {
      add(node, ts.isCallExpression(parent) && parent.expression === node);
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      node.name.text === 'winMinor'
    ) {
      add(node, ts.isCallExpression(parent) && parent.expression === node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function mentionsPay(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === 'payX100') return true;
  return ts.forEachChild(node, mentionsPay) === true;
}

/** Умножение, деление, остаток и степень, где в операнде есть payX100. */
function payArithmetic(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ARITHMETIC.has(node.operatorToken.kind) && (mentionsPay(node.left) || mentionsPay(node.right))) {
      found.push(`${String(lineOf(source, node))}: ${node.getText(source)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('скан места winMinor ловит нарушения', () => {
  it('второй вызов и вызов не в #price', () => {
    const text = [
      "import { winMinor } from '../core/money.ts';",
      'class RgsServer {',
      '  #price(bet: number, pay: number) { return winMinor(bet, pay); }',
      '  #endRound(bet: number, pay: number) { return winMinor(bet, pay); }',
      '}',
      'function helper() { return winMinor(1, 2); }',
    ].join('\n');
    expect(winMinorReferences('src/server/x.ts', text)).toStrictEqual([
      { line: 3, call: true, owner: 'RgsServer.#price' },
      { line: 4, call: true, owner: 'RgsServer.#endRound' },
      { line: 6, call: true, owner: 'helper' },
    ]);
  });

  it('ссылка без вызова — тоже ссылка: так формула уходит в обход', () => {
    const text = "import { winMinor } from '../core/money.ts';\nconst price = winMinor; const o = { winMinor };";
    expect(winMinorReferences('src/server/x.ts', text)).toStrictEqual([
      { line: 2, call: false, owner: null },
      { line: 2, call: false, owner: null },
    ]);
  });

  it('под другим именем, через namespace и реэкспортом', () => {
    const text = [
      "import { winMinor as price } from '../core/money.ts';",
      "import * as money from '../core/money.ts';",
      "export { winMinor } from '../core/money.ts';",
      'const a = price(1, 2);',
      'const b = money.winMinor(1, 2);',
    ].join('\n');
    expect(winMinorReferences('src/server/x.ts', text)).toStrictEqual([
      { line: 3, call: false, owner: null },
      { line: 4, call: true, owner: null },
      { line: 5, call: true, owner: null },
    ]);
  });

  it('поля записей и своя переменная с именем winMinor без импорта — не ссылки', () => {
    const text = [
      "import { isBetLevel } from '../core/money.ts';",
      'const w = round.winMinor; const r = { winMinor: 5 }; interface R { readonly winMinor: number }',
      "function check(value: R) { const winMinor = value['winMinor']; return winMinor; }",
    ].join('\n');
    expect(winMinorReferences('src/server/x.ts', text)).toStrictEqual([]);
  });

  it('самодельный расчёт с payX100', () => {
    const text = [
      'const a = (bet * round.payX100) / 100;',
      'const b = round.payX100 % 100;',
      'let c = 1; c *= payX100;',
      'const ok = round.payX100 === replayed.payX100 && payX100 + 1 > 0;',
    ].join('\n');
    expect(payArithmetic('src/server/x.ts', text)).toStrictEqual([
      '1: (bet * round.payX100) / 100',
      '1: bet * round.payX100',
      '2: round.payX100 % 100',
      '3: c *= payX100',
    ]);
  });
});

describe('server/ на настоящем репозитории', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const files = scanRepo(root, ['src/server']).files;
  const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');

  it('обход нашёл файлы сервера', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('winMinor — одна ссылка на весь server/, это вызов в RgsServer.#price', () => {
    const references = files.flatMap((file) => winMinorReferences(file, read(file)).map((ref) => ({ file, call: ref.call, owner: ref.owner })));
    expect(references).toStrictEqual([{ file: 'src/server/rgs-server.ts', call: true, owner: 'RgsServer.#price' }]);
  });

  it('нигде нет умножения или деления с payX100', () => {
    expect(files.flatMap((file) => payArithmetic(file, read(file)).map((hit) => `${file}:${hit}`))).toStrictEqual([]);
  });
});
