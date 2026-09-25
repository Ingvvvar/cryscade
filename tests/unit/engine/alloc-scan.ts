import ts from 'typescript';

// Аллокации в горячем пути движка — по синтаксису. Проверяются тела функций, методов и аксессоров.
// Не проверяются: конструкторы и инициализаторы полей (буферы создаются там один раз), код верхнего
// уровня модуля (константы) и выражение после throw (исключительный путь).

export interface AllocFinding {
  readonly owner: string;
  readonly kind: string;
  readonly line: number;
}

export interface AllocScan {
  /** Проверенные функции: `Класс.метод` или имя функции. */
  readonly functions: readonly string[];
  readonly findings: readonly AllocFinding[];
}

const ALLOCATING_METHODS = new Set([
  'map',
  'filter',
  'slice',
  'subarray',
  'concat',
  'flat',
  'flatMap',
  'from',
  'of',
  'split',
  'join',
  'bind',
  'entries',
  'keys',
  'values',
  'toSorted',
  'toReversed',
  'toSpliced',
  'with',
]);

function allocationKind(node: ts.Node): string | null {
  if (ts.isNewExpression(node)) return 'new';
  if (ts.isArrayLiteralExpression(node)) return 'литерал массива';
  if (ts.isObjectLiteralExpression(node)) return 'литерал объекта';
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return 'замыкание';
  if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return 'spread';
  if (ts.isTemplateExpression(node)) return 'шаблонная строка';
  if (ts.isRegularExpressionLiteral(node)) return 'регулярное выражение';
  if (ts.isForOfStatement(node)) return 'for...of';
  if (ts.isForInStatement(node)) return 'for...in';
  if (ts.isArrayBindingPattern(node)) return 'деструктуризация массива';
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    [node.left, node.right].some((side) => ts.isStringLiteral(side) || ts.isNoSubstitutionTemplateLiteral(side))
  ) {
    return 'склейка строк';
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const name = node.expression.name.text;
    if (ALLOCATING_METHODS.has(name)) return `.${name}()`;
  }
  return null;
}

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

function nameOf(node: FunctionNode, source: ts.SourceFile): string {
  const own = node.name === undefined ? '<анонимная>' : node.name.getText(source);
  const owner = node.parent;
  if (ts.isClassDeclaration(owner)) return `${owner.name?.text ?? '<класс>'}.${own}`;
  return own;
}

export function scanAllocations(fileName: string, text: string): AllocScan {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const functions: string[] = [];
  const findings: AllocFinding[] = [];

  const visit = (node: ts.Node, owner: string | null): void => {
    if (ts.isConstructorDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isThrowStatement(node)) return;
    if (owner === null && isFunctionNode(node)) {
      const name = nameOf(node, source);
      functions.push(name);
      ts.forEachChild(node, (child) => {
        visit(child, name);
      });
      return;
    }
    if (owner !== null) {
      const kind = allocationKind(node);
      if (kind !== null) {
        findings.push({ owner, kind, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, owner);
    });
  };
  visit(source, null);
  return { functions, findings };
}
