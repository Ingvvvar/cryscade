import ts from 'typescript';
import { resolveImport } from './graph.ts';

// Холостые тесты (фаза 9, аудит). Разбор — компилятором TypeScript, по узлам, а не по тексту: строка с «expect(true)»
// внутри литерала — не проверка. Находит:
// - тест без проверок (хуки beforeAll/afterAll — не тесты);
// - проверку, которая не может упасть: expect литерала, expect(a).toBe(a), expect без сопоставителя;
// - skip, only, todo, fixme, skipIf, runIf — у тестов и групп;
// - намеренный провал test.fail — его держат только положительные контроли;
// - скан без «нашёл больше нуля»: проверка в цикле, every или forEach по набору, у которого тест не проверил размер, —
//   на пустом наборе такой тест проходит молча. Набор, пустым не бывающий по построению, сканом не считается: литерал
//   массива или объекта (и имя, связанное с ним в том же файле) и цикл for со счётчиком до положительного литерала.
// Проверка — expect…, assert…, fc.assert и вызов помощника: функции или метода, в теле которых есть проверка, с
// замыканием (помощник помощника — тоже помощник). Функция находится по имени в своём файле или по импорту, метод — по
// имени среди методов своего файла и файлов, из которых он импортирует.

export interface TestSource {
  readonly path: string;
  readonly text: string;
}

export interface Vacuous {
  /** Тест без единой проверки. */
  readonly noAssertions: readonly string[];
  /** Проверка, которая не может упасть. */
  readonly cannotFail: readonly string[];
  /** skip, only, todo, fixme, skipIf, runIf. */
  readonly skipped: readonly string[];
  /** test.fail — намеренный провал. */
  readonly expectedFailures: readonly string[];
  /** Проверка по набору без проверки его размера. */
  readonly unsizedScans: readonly string[];
}

const TEST_NAMES = new Set(['it', 'test']);
const SKIP_MODIFIERS = new Set(['skip', 'only', 'todo', 'fixme', 'skipIf', 'runIf']);
/** Модификаторы, у которых тело — тест; остальные (describe, хуки, use, step, extend) — не тесты. */
const TEST_MODIFIERS = new Set(['each', 'concurrent', 'sequential', 'fails', 'fail', 'only', 'skip', 'todo', 'fixme', 'skipIf', 'runIf']);
const SIZE_MATCHERS = new Set(['toHaveLength', 'toHaveCount', 'toBeGreaterThan', 'toBeGreaterThanOrEqual']);
const SELF_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);

/** Корень цепочки вызова: expect(…).not.toBe → expect; fc.assert → fc.assert. */
function root(expression: ts.Expression): ts.Expression {
  let node = expression;
  for (;;) {
    if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = node.expression;
    else if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    else return node;
  }
}

function calleeName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return null;
}

/** Помощники: функции (путь#имя) и методы (путь#.имя), в теле которых есть проверка; paths — все разобранные файлы. */
export interface Helpers {
  readonly functions: ReadonlySet<string>;
  readonly methods: ReadonlySet<string>;
  readonly paths: ReadonlySet<string>;
}

interface Scope {
  /** Имя функции в файле → путь#имя: объявленная в файле или импортированная из разобранного файла. */
  readonly functions: ReadonlyMap<string, string>;
  /** Где искать методы: свой файл и импортированные. */
  readonly files: readonly string[];
}

function isAssertion(call: ts.CallExpression, helpers: Helpers, scope: Scope): boolean {
  const base = root(call.expression);
  if (ts.isIdentifier(base) && (base.text === 'expect' || base.text === 'assert')) return true;
  if (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) && call.expression.expression.text === 'fc' && call.expression.name.text === 'assert') return true;
  if (ts.isIdentifier(call.expression)) return helpers.functions.has(scope.functions.get(call.expression.text) ?? '');
  const name = calleeName(call);
  return name !== null && scope.files.some((file) => helpers.methods.has(`${file}#.${name}`));
}

function contains(node: ts.Node, test: (node: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (test(child)) found = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

const hasAssertion = (node: ts.Node, helpers: Helpers, scope: Scope): boolean => contains(node, (child) => ts.isCallExpression(child) && isAssertion(child, helpers, scope));

interface Body {
  /** Функция — путь#имя, метод — путь#.имя. */
  readonly key: string;
  readonly method: boolean;
  readonly body: ts.Node;
  readonly scope: Scope;
}

/** Тела функций и методов файла и его область имён: свои функции и импорты из разобранных файлов. */
function bodiesOf(path: string, source: ts.SourceFile, paths: ReadonlySet<string>): { readonly bodies: Body[]; readonly scope: Scope } {
  const functions = new Map<string, string>();
  const files = [path];
  const found: Array<{ readonly name: string; readonly method: boolean; readonly body: ts.Node }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveImport(path, node.moduleSpecifier.text, (file) => paths.has(file));
      if (target.kind === 'file') {
        files.push(target.path);
        const bindings = node.importClause?.namedBindings;
        if (bindings !== undefined && ts.isNamedImports(bindings)) for (const element of bindings.elements) functions.set(element.name.text, `${target.path}#${(element.propertyName ?? element.name).text}`);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) found.push({ name: node.name.text, method: false, body: node.body });
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.body !== undefined) found.push({ name: node.name.text, method: true, body: node.body });
    if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && ts.isIdentifier(node.name) && node.initializer !== undefined && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      found.push({ name: node.name.text, method: ts.isPropertyDeclaration(node), body: node.initializer.body });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const { name, method } of found) if (!method) functions.set(name, `${path}#${name}`);
  const scope = { functions, files };
  return { bodies: found.map(({ name, method, body }) => ({ key: method ? `${path}#.${name}` : `${path}#${name}`, method, body, scope })), scope };
}

const parse = (file: TestSource): ts.SourceFile => ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, file.path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Функции-помощники с проверками внутри — по всем файлам, до неподвижной точки. */
export function assertingHelpers(sources: readonly TestSource[]): Helpers {
  const paths = new Set(sources.map((file) => file.path));
  const bodies = sources.flatMap((file) => bodiesOf(file.path, parse(file), paths).bodies);
  const helpers = { functions: new Set<string>(), methods: new Set<string>(), paths };
  for (let grew = true; grew; ) {
    grew = false;
    for (const { key, method, body, scope } of bodies) {
      const known = method ? helpers.methods : helpers.functions;
      if (!known.has(key) && hasAssertion(body, helpers, scope)) {
        known.add(key);
        grew = true;
      }
    }
  }
  return helpers;
}


function unwrap(expression: ts.Expression): ts.Expression {
  let node = expression;
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function isLiteral(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(node) && node.text === 'undefined') return true;
  if (ts.isNumericLiteral(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  return ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand);
}

/** Имена, связанные в файле с непустым литералом массива или объекта. */
function literalNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && nonEmptyLiteral(node.initializer, names)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/**
 * Набор, пустым не бывающий по построению: литерал (или имя литерала), new Map и new Set от литерала, их entries(),
 * Object.values/keys/entries литерала.
 */
function nonEmptyLiteral(expression: ts.Expression, names: ReadonlySet<string>): boolean {
  const node = unwrap(expression);
  // [...xs] пуст вместе с xs: непустой — элемент без spread или spread непустого литерала.
  if (ts.isArrayLiteralExpression(node)) return node.elements.some((element) => !ts.isSpreadElement(element) || nonEmptyLiteral(element.expression, names));
  if (ts.isObjectLiteralExpression(node)) return node.properties.length > 0;
  if (ts.isIdentifier(node)) return names.has(node.text);
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ['Map', 'Set'].includes(node.expression.text)) {
    const [argument] = node.arguments ?? [];
    return argument !== undefined && nonEmptyLiteral(argument, names);
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const { expression: target, name } = node.expression;
    if (ts.isIdentifier(target) && target.text === 'Object' && ['values', 'keys', 'entries'].includes(name.text)) {
      const [argument] = node.arguments;
      return argument !== undefined && nonEmptyLiteral(argument, names);
    }
    if (['entries', 'keys', 'values'].includes(name.text) && node.arguments.length === 0) return nonEmptyLiteral(target, names);
  }
  return false;
}

/** for (let i = 0; i < N; …) с положительным литералом N (или i <= N, N ≥ 0) — счётчик, а не скан. */
function literalCounter(loop: ts.ForStatement): boolean {
  const condition = loop.condition;
  if (condition === undefined || !ts.isBinaryExpression(condition)) return false;
  const value = numeric(condition.right);
  if (value === null) return false;
  if (condition.operatorToken.kind === ts.SyntaxKind.LessThanToken) return value > 0;
  return condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken && value >= 0;
}

function numeric(expression: ts.Expression): number | null {
  const node = unwrap(expression);
  return ts.isNumericLiteral(node) ? Number(node.text.replaceAll('_', '')) : null;
}

function hasSizeCheck(body: ts.Node): boolean {
  return contains(body, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
    const matcher = node.expression.name.text;
    if (SIZE_MATCHERS.has(matcher)) return true;
    // expect(xs.length).toBe(5), expect(set.size).not.toBe(0) — размер литералом, не нулём.
    if (!SELF_MATCHERS.has(matcher)) return false;
    const base = root(node.expression);
    const expectCall = base.parent;
    if (!ts.isIdentifier(base) || base.text !== 'expect' || !ts.isCallExpression(expectCall)) return false;
    const [subject] = expectCall.arguments;
    const [expected] = node.arguments;
    if (subject === undefined || expected === undefined) return false;
    const measured = unwrap(subject);
    if (!ts.isPropertyAccessExpression(measured) || !['length', 'size'].includes(measured.name.text)) return false;
    const negated = ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === 'not';
    const value = numeric(expected);
    return value !== null && (negated ? value === 0 : value > 0);
  });
}

/** Сканы по набору с проверкой внутри: цикл for…of и for…in, forEach, every внутри expect; счётчики и литералы — нет. */
function scans(body: ts.Node, helpers: Helpers, scope: Scope, names: ReadonlySet<string>): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && hasAssertion(node.statement, helpers, scope) && !nonEmptyLiteral(node.expression, names)) out.push(node);
    if (ts.isForStatement(node) && hasAssertion(node.statement, helpers, scope) && !literalCounter(node)) out.push(node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: target, name } = node.expression;
      const [callback] = node.arguments;
      if (name.text === 'forEach' && callback !== undefined && hasAssertion(callback, helpers, scope) && !nonEmptyLiteral(target, names)) out.push(node);
      if (name.text === 'every' && !nonEmptyLiteral(target, names) && insideExpect(node)) out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

function insideExpect(node: ts.Node): boolean {
  for (let parent = node.parent; !ts.isSourceFile(parent); parent = parent.parent) {
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'expect') return true;
    if (ts.isFunctionLike(parent)) return false;
  }
  return false;
}

/** Проверки, которые не могут упасть: expect(литерал), expect(a).toBe(a), expect(…) без сопоставителя. */
function cannotFail(body: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'expect') {
      const [subject] = node.arguments;
      const literal = subject !== undefined && isLiteral(subject);
      const access = node.parent;
      const matcherCall = ts.isPropertyAccessExpression(access) ? access.parent : undefined;
      const expected = matcherCall !== undefined && ts.isCallExpression(matcherCall) && ts.isPropertyAccessExpression(access) && SELF_MATCHERS.has(access.name.text) ? matcherCall.arguments[0] : undefined;
      const self = subject !== undefined && expected !== undefined && subject.getText() === expected.getText();
      // Оператор expect(x); или expect(x).not; — сопоставителя нет.
      let statement: ts.Node = node;
      while (ts.isAwaitExpression(statement.parent) || (ts.isPropertyAccessExpression(statement.parent) && statement.parent.expression === statement)) statement = statement.parent;
      if (literal || self || ts.isExpressionStatement(statement.parent)) out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

/** Имя вызова теста: it, test, it.each(...), test.describe — и модификатор. */
function testCall(expression: ts.Expression): { readonly base: string; readonly modifier: string | null } | null {
  if (ts.isIdentifier(expression)) return { base: expression.text, modifier: null };
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) return { base: expression.expression.text, modifier: expression.name.text };
  if (ts.isPropertyAccessExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && ts.isIdentifier(expression.expression.expression)) {
    // test.describe.skip, it.concurrent.each — база и последний модификатор.
    return { base: expression.expression.expression.text, modifier: expression.name.text };
  }
  if (ts.isCallExpression(expression)) return testCall(expression.expression);
  return null;
}

export function findVacuous(sources: readonly TestSource[], helpers: Helpers): Vacuous {
  const out = { noAssertions: [] as string[], cannotFail: [] as string[], skipped: [] as string[], expectedFailures: [] as string[], unsizedScans: [] as string[] };
  for (const file of sources) {
    const source = parse(file);
    const names = literalNames(source);
    const { scope } = bodiesOf(file.path, source, helpers.paths);
    const at = (node: ts.Node): string => `${file.path}:${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)}`;
    const titles: string[] = [];
    const visit = (node: ts.Node): void => {
      let title: string | null = null;
      if (ts.isCallExpression(node)) {
        const call = testCall(node.expression);
        const isBase = call !== null && (TEST_NAMES.has(call.base) || call.base === 'describe');
        // it.skipIf(cond)('…', fn): пропуск считается на внутреннем вызове it.skipIf(cond), внешний — тест.
        const direct = !ts.isCallExpression(node.expression);
        if (call !== null && isBase && direct && call.modifier !== null && SKIP_MODIFIERS.has(call.modifier)) out.skipped.push(`${at(node)} ${call.base}.${call.modifier}`);
        if (call !== null && TEST_NAMES.has(call.base) && call.modifier === 'fail' && node.arguments.length > 0) out.expectedFailures.push(`${at(node)} ${titles.at(-1) ?? '…'}`);
        const body = node.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
        const isTest = call !== null && TEST_NAMES.has(call.base) && (call.modifier === null || TEST_MODIFIERS.has(call.modifier));
        if (isTest && body !== undefined && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))) {
          const [first] = node.arguments;
          title = first !== undefined && ts.isStringLiteralLike(first) ? first.text.slice(0, 60) : '…';
          const where = `${at(node)} ${title}`;
          if (!hasAssertion(body.body, helpers, scope)) out.noAssertions.push(where);
          for (const check of cannotFail(body.body)) out.cannotFail.push(`${at(check)} ${title}`);
          if (!hasSizeCheck(body.body)) for (const scan of scans(body.body, helpers, scope, names)) out.unsizedScans.push(`${at(scan)} ${title}`);
        }
      }
      if (title !== null) titles.push(title);
      ts.forEachChild(node, visit);
      if (title !== null) titles.pop();
    };
    visit(source);
  }
  return out;
}
