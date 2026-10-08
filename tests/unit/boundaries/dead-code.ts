import path from 'node:path';
import ts from 'typescript';
import { resolveImport } from './graph.ts';

// Мёртвый код (фаза 9, аудит): файлы src/ и tools/, которых не достичь от точек входа, и экспорты, которые никто не
// импортирует. Разбор — компилятором TypeScript. Импорт имени идёт сквозь бочки: `export { a } from` и `export * from`
// ведут к месту объявления. Динамический `import()` и `import * as` считаются использованием всех экспортов модуля:
// что из них возьмут, статически не узнать.

export interface Source {
  /** Путь относительно корня, через `/`. */
  readonly path: string;
  readonly text: string;
}

interface ReExport {
  readonly from: string;
  readonly name: string;
}

interface Module {
  /** Имена, объявленные и экспортированные здесь, со строкой объявления. */
  readonly local: Map<string, number>;
  /** `export { a as b } from './x'` — b ← (x, a). */
  readonly named: Map<string, ReExport & { readonly line: number }>;
  /** `export * from './x'` — x. */
  readonly stars: string[];
  /** Импорты имён: (файл, имя); '*' — все экспорты модуля. */
  readonly uses: ReExport[];
  /** Файлы, куда ведут импорты (и динамические). */
  readonly edges: string[];
}

function hasExport(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function parse(file: Source, exists: (file: string) => boolean): Module {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, file.path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const line = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const target = (specifier: ts.Expression | undefined): string | null => {
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return null;
    const resolved = resolveImport(file.path, specifier.text, exists);
    return resolved.kind === 'file' ? resolved.path : null;
  };
  const module: Module = { local: new Map(), named: new Map(), stars: [], uses: [], edges: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const from = target(node.moduleSpecifier);
      if (from !== null) {
        module.edges.push(from);
        const clause = node.importClause;
        if (clause?.name !== undefined) module.uses.push({ from, name: 'default' });
        const bindings = clause?.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) module.uses.push({ from, name: '*' });
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) module.uses.push({ from, name: (element.propertyName ?? element.name).text });
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const from = target(node.moduleSpecifier);
      if (node.moduleSpecifier !== undefined && from !== null) {
        module.edges.push(from);
        if (node.exportClause === undefined) module.stars.push(from);
        else if (ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            module.named.set(element.name.text, { from, name: (element.propertyName ?? element.name).text, line: line(element) });
          }
        } else module.uses.push({ from, name: '*' });
      } else if (node.moduleSpecifier === undefined && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) module.local.set(element.name.text, line(element));
      }
    } else if (ts.isExportAssignment(node)) {
      module.local.set('default', line(node));
    } else if (hasExport(node)) {
      const isDefault = ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (isDefault) module.local.set('default', line(node));
      else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) module.local.set(declaration.name.text, line(declaration));
      } else if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) &&
        node.name !== undefined
      ) {
        module.local.set(node.name.text, line(node));
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments !== undefined &&
      node.arguments.length === 2 &&
      ts.isPropertyAccessExpression(node.arguments[1] ?? node) &&
      (node.arguments[1] as ts.PropertyAccessExpression).name.text === 'url'
    ) {
      // new URL('./worker.ts', import.meta.url) — скрипт воркера: не импорт, но точка входа рядом с кодом.
      const from = target(node.arguments[0]);
      if (from !== null) module.edges.push(from);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const from = target(node.arguments[0]);
      if (from !== null) {
        module.edges.push(from);
        module.uses.push({ from, name: '*' });
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const from = target(node.argument.literal);
      if (from !== null) {
        module.edges.push(from);
        module.uses.push({ from, name: node.qualifier !== undefined && ts.isIdentifier(node.qualifier) ? node.qualifier.text : '*' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return module;
}

export interface DeadCode {
  /** Файлы src/ и tools/, которых не достичь от точек входа; рядом — кто их всё же импортирует (тесты). */
  readonly unreachable: readonly string[];
  /** `файл:строка имя` — экспорт, которого не импортирует никто: ни код, ни инструменты, ни тесты. */
  readonly unusedExports: readonly string[];
}

/**
 * files — весь разбираемый код (src/, tools/, tests/, конфиги); scope — где искать мёртвое (префиксы путей); entries —
 * точки входа (главный поток, воркер, скрипты package.json, конфиги).
 */
export function findDeadCode(files: readonly Source[], scope: readonly string[], entries: readonly string[]): DeadCode {
  const paths = new Set(files.map((file) => file.path));
  const exists = (file: string): boolean => paths.has(file);
  const modules = new Map(files.map((file) => [file.path, parse(file, exists)]));
  const inScope = (file: string): boolean => scope.some((prefix) => file.startsWith(prefix)) && !file.endsWith('.d.ts');

  const reached = new Set<string>();
  const queue = entries.filter((entry) => paths.has(entry));
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (reached.has(file)) continue;
    reached.add(file);
    queue.push(...(modules.get(file)?.edges ?? []));
  }

  const used = new Set<string>();
  const key = (file: string, name: string): string => `${file}#${name}`;
  const markAll = (file: string, seen: Set<string>): void => {
    const module = modules.get(file);
    if (module === undefined || seen.has(file)) return;
    seen.add(file);
    for (const name of module.local.keys()) used.add(key(file, name));
    for (const [name, origin] of module.named) {
      used.add(key(file, name));
      mark(origin.from, origin.name, new Set());
    }
    for (const star of module.stars) markAll(star, seen);
  };
  const mark = (file: string, name: string, seen: Set<string>): boolean => {
    const module = modules.get(file);
    if (module === undefined || seen.has(key(file, name))) return false;
    seen.add(key(file, name));
    if (name === '*') {
      markAll(file, new Set());
      return true;
    }
    if (module.local.has(name)) {
      used.add(key(file, name));
      return true;
    }
    const origin = module.named.get(name);
    if (origin !== undefined) {
      used.add(key(file, name));
      mark(origin.from, origin.name, seen);
      return true;
    }
    return module.stars.some((star) => mark(star, name, seen));
  };
  for (const module of modules.values()) for (const use of module.uses) mark(use.from, use.name, new Set());

  const unreachable = [...paths].filter((file) => inScope(file) && !reached.has(file)).sort();
  const unusedExports: string[] = [];
  for (const [file, module] of modules) {
    if (!inScope(file)) continue;
    for (const [name, at] of module.local) if (!used.has(key(file, name))) unusedExports.push(`${file}:${String(at)} ${name}`);
    for (const [name, origin] of module.named) if (!used.has(key(file, name))) unusedExports.push(`${file}:${String(origin.line)} ${name} (реэкспорт)`);
  }
  return { unreachable, unusedExports: unusedExports.sort() };
}

/**
 * Точки входа-скрипты: путь `tools/….ts` в тексте — в скриптах package.json, в документации (`node tools/…` руками) и в
 * коде, который запускает скрипт процессом (spawn('node', ['tools/…'])).
 */
export function scriptEntries(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap((text) => [...text.matchAll(/\b(tools\/[\w./-]+\.ts)\b/g)].map((match) => path.posix.normalize(match[1] ?? ''))))];
}
