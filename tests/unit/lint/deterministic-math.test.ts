import { ESLint, RuleTester } from 'eslint';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { deterministicMath } from '../../../lint/deterministic-math.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

tester.run('deterministic-math', deterministicMath, {
  valid: [
    'const h = Math.imul(a, 0x85ebca6b);',
    'const n = Math.clz32(x) + Math.min(a, b) + Math.max(a, b) + Math.abs(d) + Math.floor(q) + Math.trunc(q);',
    'const q = (a * b - (a * b) % 100) / 100;',
    'const m = 1 << (k - 1);',
    'const o = { Math: 1 };',
    'const p = stats.Math;',
    'class C { Math = 1; }',
  ],
  invalid: [
    { code: 'const y = Math.log(x);', errors: [{ messageId: 'method', data: { name: 'log' } }] },
    { code: 'const y = Math.exp(x);', errors: [{ messageId: 'method', data: { name: 'exp' } }] },
    { code: 'const y = Math.pow(2, k);', errors: [{ messageId: 'method', data: { name: 'pow' } }] },
    { code: 'const y = Math.round(x);', errors: [{ messageId: 'method', data: { name: 'round' } }] },
    { code: 'const y = Math.PI;', errors: [{ messageId: 'method', data: { name: 'PI' } }] },
    { code: 'const y = Math?.log(x);', errors: [{ messageId: 'method', data: { name: 'log' } }] },
    { code: "const y = Math['floor'](x);", errors: [{ messageId: 'computed' }] },
    { code: 'const y = Math[name](x);', errors: [{ messageId: 'computed' }] },
    { code: 'const m = Math;', errors: [{ messageId: 'value' }] },
    { code: 'const { log } = Math;', errors: [{ messageId: 'value' }] },
    { code: 'use(Math);', errors: [{ messageId: 'value' }] },
    { code: 'const y = 2 ** k;', errors: [{ messageId: 'power' }] },
    { code: 'x **= 2;', errors: [{ messageId: 'power' }] },
  ],
});

// Правило в конфиге висит на glob: опечатка в пути выключила бы его молча.
describe('eslint.config.js включает правило ровно для engine, rng и money', () => {
  const eslint = new ESLint({ cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
  const severity = async (file: string): Promise<unknown> =>
    (await eslint.calculateConfigForFile(file) as { rules?: Record<string, unknown> } | undefined)?.rules?.[
      'cryscade/deterministic-math'
    ];

  it.each(['src/core/engine/index.ts', 'src/core/rng/xoshiro128ss.ts', 'src/core/money.ts'])('%s — ошибка', async (file) => {
    expect(await severity(file)).toEqual([2]);
  });

  it.each(['src/core/model/config.ts', 'src/core/presentation/index.ts', 'src/core/fsm/index.ts', 'src/core/jurisdiction.ts'])(
    '%s — не включено',
    async (file) => {
      expect(await severity(file)).toBeUndefined();
    },
  );
});
