import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Граф импортов для границ §3. Разбор — компилятором TypeScript, не регулярками:
// комментарии и строки не дают ложных рёбер, `new URL(…, import.meta.url)` — не импорт.

export interface ImportRef {
  /** null — цель нельзя проверить: `import(выражение)` или `import.meta.glob`. */
  readonly specifier: string | null;
  readonly line: number;
}

export type Target =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'unresolved'; readonly specifier: string | null };

export type ModuleId =
  | 'core/model'
  | 'core/rng'
  | 'core/engine'
  | 'core/presentation'
  | 'core/fsm'
  | 'core/money'
  | 'core/jurisdiction'
  | 'core/other'
  | 'protocol'
  | 'server'
  | 'client'
  | 'render'
  | 'ui'
  | 'audio'
  | 'tools';

export type TopModule = 'core' | 'protocol' | 'server' | 'client' | 'render' | 'ui' | 'audio' | 'tools';

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

export function extractImports(fileName: string, text: string): ImportRef[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const refs: ImportRef[] = [];
  const add = (node: ts.Node, specifier: string | null): void => {
    refs.push({ specifier, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  };
  const literal = (node: ts.Node | undefined): string | null =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      add(node, literal(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, literal(node.moduleReference.expression));
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, literal(node.argument.literal));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        add(node, literal(node.arguments[0]));
      } else if (ts.isIdentifier(callee) && callee.text === 'require') {
        add(node, literal(node.arguments[0]));
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isMetaProperty(callee.expression) &&
        callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        callee.name.text.startsWith('glob')
      ) {
        add(node, null);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refs;
}

/** Пути — относительно корня репозитория, через `/`. */
export function resolveImport(fromFile: string, specifier: string | null, exists: (file: string) => boolean): Target {
  if (specifier === null) {
    return { kind: 'unresolved', specifier };
  }
  const bare = specifier.split(/[?#]/)[0] ?? '';
  if (bare.startsWith('./') || bare.startsWith('../') || bare.startsWith('/')) {
    const base = bare.startsWith('/') ? bare.slice(1) : path.posix.join(path.posix.dirname(fromFile), bare);
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = path.posix.normalize(base + suffix);
      if (exists(candidate)) {
        return { kind: 'file', path: candidate };
      }
    }
    return { kind: 'unresolved', specifier };
  }
  if (bare.startsWith('node:')) {
    return { kind: 'package', name: bare.split('/')[0] ?? bare };
  }
  const parts = bare.split('/');
  const name = bare.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? bare);
  return { kind: 'package', name };
}

const CORE_DIRS = ['model', 'rng', 'engine', 'presentation', 'fsm'] as const;
const SRC_MODULES = ['protocol', 'server', 'client', 'render', 'ui', 'audio'] as const;

export function moduleOf(file: string): ModuleId | null {
  if (file === 'src/core/money.ts') return 'core/money';
  if (file === 'src/core/jurisdiction.ts') return 'core/jurisdiction';
  for (const dir of CORE_DIRS) {
    if (file.startsWith(`src/core/${dir}/`)) return `core/${dir}`;
  }
  if (file.startsWith('src/core/')) return 'core/other';
  for (const dir of SRC_MODULES) {
    if (file.startsWith(`src/${dir}/`)) return dir;
  }
  if (file.startsWith('tools/')) return 'tools';
  return null;
}

const TOP: Readonly<Record<ModuleId, TopModule>> = {
  'core/model': 'core',
  'core/rng': 'core',
  'core/engine': 'core',
  'core/presentation': 'core',
  'core/fsm': 'core',
  'core/money': 'core',
  'core/jurisdiction': 'core',
  'core/other': 'core',
  protocol: 'protocol',
  server: 'server',
  client: 'client',
  render: 'render',
  ui: 'ui',
  audio: 'audio',
  tools: 'tools',
};

export function topModule(id: ModuleId): TopModule {
  return TOP[id];
}

// Таблица §3 целиком: что модулю можно. Всё остальное нельзя.
const CORE_ALL: readonly ModuleId[] = [
  'core/model',
  'core/rng',
  'core/engine',
  'core/presentation',
  'core/fsm',
  'core/money',
  'core/jurisdiction',
  'core/other',
];
// model, money, jurisdiction, fsm, presentation не импортируют engine и rng.
const CORE_PURE: readonly ModuleId[] = CORE_ALL.filter((id) => id !== 'core/engine' && id !== 'core/rng');

interface Rule {
  readonly modules: readonly ModuleId[];
  readonly packages: (name: string) => boolean;
}

const NO_PACKAGES = (): boolean => false;

export const RULES: Readonly<Record<ModuleId, Rule>> = {
  'core/model': { modules: CORE_PURE, packages: NO_PACKAGES },
  'core/money': { modules: CORE_PURE, packages: NO_PACKAGES },
  'core/jurisdiction': { modules: CORE_PURE, packages: NO_PACKAGES },
  'core/fsm': { modules: CORE_PURE, packages: NO_PACKAGES },
  'core/presentation': { modules: CORE_PURE, packages: NO_PACKAGES },
  'core/rng': { modules: CORE_ALL, packages: NO_PACKAGES },
  'core/engine': { modules: CORE_ALL, packages: NO_PACKAGES },
  'core/other': { modules: CORE_ALL, packages: NO_PACKAGES },
  protocol: { modules: ['protocol', 'core/model'], packages: NO_PACKAGES },
  server: { modules: ['server', ...CORE_ALL, 'protocol'], packages: NO_PACKAGES },
  client: {
    modules: ['client', 'core/model', 'core/fsm', 'core/presentation', 'core/jurisdiction', 'core/money', 'protocol'],
    packages: NO_PACKAGES,
  },
  render: { modules: ['render', 'core/model', 'core/presentation'], packages: (name) => name === 'pixi.js' },
  ui: {
    modules: ['ui', 'client', 'render', 'audio', 'core/model', 'protocol'],
    packages: (name) =>
      ['react', 'react-dom', '@fontsource-variable/unbounded', '@fontsource-variable/manrope'].includes(name),
  },
  audio: { modules: ['audio', 'core/model', 'core/presentation'], packages: NO_PACKAGES },
  tools: { modules: ['tools', ...CORE_ALL, 'server'], packages: (name) => name.startsWith('node:') },
};

/** Разрешено ли прямое ребро. Возвращает причину запрета или null. */
export function checkEdge(fromFile: string, target: Target): string | null {
  const from = moduleOf(fromFile);
  if (from === null) {
    return `${fromFile} вне модулей §3`;
  }
  const rule = RULES[from];
  switch (target.kind) {
    case 'unresolved':
      return `${fromFile}: импорт не проверить (${target.specifier ?? 'не литерал'})`;
    case 'package':
      return rule.packages(target.name) ? null : `${from} → пакет ${target.name}`;
    case 'file': {
      const to = moduleOf(target.path);
      if (to === null) {
        return `${fromFile} → ${target.path}: цель вне модулей §3`;
      }
      return rule.modules.includes(to) ? null : `${from} → ${to} (${fromFile} → ${target.path})`;
    }
  }
}

export type Graph = ReadonlyMap<string, readonly string[]>;

const PRESENTATION_SIDE: readonly TopModule[] = ['client', 'render', 'ui', 'audio'];
const HIDDEN: readonly ModuleId[] = ['core/engine', 'core/rng', 'server'];

/** Замыкание: из client/, render/, ui/, audio/ не достижим ни один файл core/engine, core/rng, server/. */
export function forbiddenReach(graph: Graph): string[] {
  const violations: string[] = [];
  for (const start of graph.keys()) {
    const id = moduleOf(start);
    if (id === null || !PRESENTATION_SIDE.includes(topModule(id))) continue;
    const parent = new Map<string, string>();
    const queue = [start];
    const seen = new Set(queue);
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const reachedId = moduleOf(file);
      if (reachedId !== null && HIDDEN.includes(reachedId)) {
        const chain = [file];
        for (let step = parent.get(file); step !== undefined; step = parent.get(step)) chain.unshift(step);
        violations.push(chain.join(' → '));
        continue;
      }
      for (const next of graph.get(file) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          parent.set(next, file);
          queue.push(next);
        }
      }
    }
  }
  return violations;
}

export interface RepoScan {
  readonly files: readonly string[];
  readonly imports: ReadonlyMap<string, readonly { readonly ref: ImportRef; readonly target: Target }[]>;
  readonly graph: Graph;
}

function listCode(root: string, dir: string): string[] {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const rel = path.posix.join(dir, entry);
    if (statSync(path.join(root, rel)).isDirectory()) {
      out.push(...listCode(root, rel));
    } else if (CODE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(rel);
    }
  }
  return out;
}

export function scanRepo(root: string, dirs: readonly string[] = ['src', 'tools']): RepoScan {
  const files = dirs.flatMap((dir) => listCode(root, dir)).sort();
  const exists = (file: string): boolean => {
    const abs = path.join(root, file);
    return existsSync(abs) && statSync(abs).isFile();
  };
  const imports = new Map<string, { ref: ImportRef; target: Target }[]>();
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const refs = extractImports(file, readFileSync(path.join(root, file), 'utf8'));
    const resolved = refs.map((ref) => ({ ref, target: resolveImport(file, ref.specifier, exists) }));
    imports.set(file, resolved);
    graph.set(
      file,
      resolved.flatMap(({ target }) => (target.kind === 'file' ? [target.path] : [])),
    );
  }
  return { files, imports, graph };
}

/** core/, protocol/, server/ делят браузер и Node: относительный импорт — только с `.ts`, ровно в файл. */
export function extensionViolations(scan: RepoScan): string[] {
  const violations: string[] = [];
  for (const [file, refs] of scan.imports) {
    const id = moduleOf(file);
    if (id === null || !['core', 'protocol', 'server'].includes(topModule(id))) continue;
    for (const { ref, target } of refs) {
      const spec = ref.specifier;
      if (spec === null || !(spec.startsWith('./') || spec.startsWith('../'))) continue;
      const exact = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!spec.endsWith('.ts') || target.kind !== 'file' || target.path !== exact) {
        violations.push(`${file}:${String(ref.line)} ${spec}`);
      }
    }
  }
  return violations;
}
