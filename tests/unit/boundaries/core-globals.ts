import ts from 'typescript';

// Запрещённые глобалы по модулям (§3). Math.random запрещён везде, где идёт скан: случайность приходит портом.

/** core/: время, случайность, crypto, корни DOM. Весь DOM целиком отсекает tsconfig.core.json (lib без DOM). */
export const CORE_FORBIDDEN: ReadonlySet<string> = new Set([
  'Date',
  'performance',
  'crypto',
  'window',
  'document',
  'navigator',
  'self',
  'globalThis',
]);

/**
 * server/ вне worker.ts: сверх core/ — браузер воркера и таймеры. lib WebWorker их типизирует, поэтому держит скан:
 * IndexedDB, Web Locks (через navigator), BroadcastChannel, crypto, сеть и время — только в worker.ts, логика на портах.
 */
export const SERVER_FORBIDDEN: ReadonlySet<string> = new Set([
  ...CORE_FORBIDDEN,
  'indexedDB',
  'IDBKeyRange',
  'BroadcastChannel',
  'postMessage',
  'importScripts',
  'location',
  'caches',
  'fetch',
  'setTimeout',
  'setInterval',
]);

export interface Finding {
  readonly name: string;
  readonly line: number;
}

/** Идентификатор стоит на месте имени свойства, а не ссылки на глобал. */
export function isPropertyName(node: ts.Identifier): boolean {
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

export function findForbiddenGlobals(fileName: string, text: string, forbidden: ReadonlySet<string> = CORE_FORBIDDEN): Finding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const report = (node: ts.Node, name: string): void => {
    findings.push({ name, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isPropertyName(node)) {
      if (forbidden.has(node.text)) {
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
