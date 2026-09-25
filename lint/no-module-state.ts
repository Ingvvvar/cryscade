import type { Rule } from 'eslint';

// На уровне модуля нет let, var и new: ни синглтонов, ни изменяемого состояния модуля.
// «Уровень модуля» — код, который исполняется при загрузке модуля: верхний уровень,
// статические поля и блоки классов, немедленно вызываемые функции.
// Тело функции и инициализатор поля экземпляра исполняются позже и уровнем модуля не считаются.

type Node = Rule.Node;

const FUNCTIONS = new Set<string>(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function runsLater(node: Node, child: Node): boolean {
  if (FUNCTIONS.has(node.type)) {
    const caller = node.parent;
    const immediatelyCalled = caller?.type === 'CallExpression' && caller.callee === node;
    return !immediatelyCalled;
  }
  // `accessor`-поля (их нет в типах ESTree) не различаются: поле экземпляра даст лишнее срабатывание, не пропуск.
  return node.type === 'PropertyDefinition' && !node.static && node.value === child;
}

function atModuleLevel(node: Node): boolean {
  let child = node;
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (runsLater(parent, child)) return false;
    child = parent;
  }
  return true;
}

export const noModuleState: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'На уровне модуля нет let, var и new.' },
    schema: [],
    messages: {
      binding: 'На уровне модуля нет {{kind}}: состояние живёт в экземпляре.',
      instance: 'На уровне модуля нет new: экземпляры связывает корень композиции внутри функции.',
    },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if ((node.kind === 'let' || node.kind === 'var') && atModuleLevel(node)) {
          context.report({ node, messageId: 'binding', data: { kind: node.kind } });
        }
      },
      NewExpression(node) {
        if (atModuleLevel(node)) {
          context.report({ node, messageId: 'instance' });
        }
      },
    };
  },
};
