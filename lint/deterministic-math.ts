import type { Rule } from 'eslint';

// Детерминизм между движками JS (§4.7). Книгу строит V8, повтор по ссылке может пересчитать Safari:
// log, exp, pow и оператор ** спецификация разрешает считать приближённо — последний бит вправе разойтись.
// Разрешены только методы Math с точным результатом, которые нужны движку. Math как значение и
// Math[выражение] не проверить — они запрещены тоже.

type Node = Rule.Node;

const ALLOWED = new Set<string>(['imul', 'clz32', 'min', 'max', 'abs', 'floor', 'trunc']);
const ALLOWED_LIST = [...ALLOWED].join(', ');

/** Идентификатор стоит на месте имени свойства или ключа, а не ссылки на глобал Math. */
function isPropertyName(node: Node): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.type === 'MemberExpression') return parent.property === node && !parent.computed;
  if (parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') {
    return parent.key === node && !parent.computed;
  }
  return false;
}

export const deterministicMath: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Только точные методы Math и без **: движок и деньги считаются одинаково во всех движках JS.' },
    schema: [],
    messages: {
      method: `Math.{{name}} вне списка §4.7: разрешены только ${ALLOWED_LIST}.`,
      computed: `Math[...] не проверить: разрешены только прямые обращения к ${ALLOWED_LIST}.`,
      value: 'Math как значение не проверить: только Math.<разрешённый метод>.',
      power: '** — приближённое возведение в степень, между движками вправе разойтись. Степень двойки — сдвигом.',
    },
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name !== 'Math' || isPropertyName(node)) return;
        const parent = node.parent;
        if (parent.type === 'MemberExpression' && parent.object === node) {
          const property = parent.property;
          if (parent.computed || property.type !== 'Identifier') {
            context.report({ node: parent, messageId: 'computed' });
          } else if (!ALLOWED.has(property.name)) {
            context.report({ node: parent, messageId: 'method', data: { name: property.name } });
          }
          return;
        }
        context.report({ node, messageId: 'value' });
      },
      BinaryExpression(node) {
        if (node.operator === '**') context.report({ node, messageId: 'power' });
      },
      AssignmentExpression(node) {
        if (node.operator === '**=') context.report({ node, messageId: 'power' });
      },
    };
  },
};
