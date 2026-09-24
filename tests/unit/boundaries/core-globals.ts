import ts from 'typescript';

// Запрещённые глобалы в core/: время, случайность, crypto, корни DOM.
// Весь DOM целиком отсекает tsconfig.core.json (lib без DOM); здесь — то, что есть и в lib ES.

const FORBIDDEN = new Set(['Date', 'performance', 'crypto', 'window', 'document', 'navigator', 'self', 'globalThis']);

export interface Finding {
  readonly name: string;
  readonly line: number;
}

/** Идентификатор стоит на месте имени свойства, а не ссылки на глобал. */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
      parent.name === node)
  );
}

export function findForbiddenGlobals(fileName: string, text: string): Finding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const report = (node: ts.Node, name: string): void => {
    findings.push({ name, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isPropertyName(node)) {
      if (FORBIDDEN.has(node.text)) {
        report(node, node.text);
      } else if (node.text === 'Math') {
        // Math можно только как `Math.<не random>`: иначе random уходит через деструктуризацию или индекс.
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
          if (parent.name.text === 'random') report(node, 'Math.random');
        } else {
          report(node, 'Math');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}
