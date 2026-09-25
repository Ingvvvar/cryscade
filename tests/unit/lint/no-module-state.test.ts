import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { noModuleState } from '../../../lint/no-module-state.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

tester.run('no-module-state', noModuleState, {
  valid: [
    'const LIMIT = 10;',
    'export const SYMBOLS = ["a", "b"] as const;',
    'function make() { return new Map(); }',
    'export const make = () => new Map();',
    'function count() { let i = 0; i += 1; return i; }',
    'function f(cache = new Map()) { return cache; }',
    'class Grid { readonly #cells = new Uint8Array(42); }',
    'class Grid { static create() { return new Grid(); } }',
    'class Grid { constructor() { const tmp = new Array(3); tmp.fill(0); } }',
    'function mount() { throw new Error("нет #root"); }\nmount();',
  ],
  invalid: [
    { code: 'let counter = 0;', errors: [{ messageId: 'binding', data: { kind: 'let' } }] },
    { code: 'var legacy = 1;', errors: [{ messageId: 'binding', data: { kind: 'var' } }] },
    { code: 'export let current = 0;', errors: [{ messageId: 'binding', data: { kind: 'let' } }] },
    { code: 'for (let i = 0; i < 1; i++) {}', errors: [{ messageId: 'binding', data: { kind: 'let' } }] },
    { code: 'const cache = new Map();', errors: [{ messageId: 'instance' }] },
    { code: 'export default new Map();', errors: [{ messageId: 'instance' }] },
    { code: 'new Map().clear();', errors: [{ messageId: 'instance' }] },
    { code: 'const box = { map: new Map() };', errors: [{ messageId: 'instance' }] },
    { code: 'throw new Error("нет #root");', errors: [{ messageId: 'instance' }] },
    { code: 'const lazy = (() => new Map())();', errors: [{ messageId: 'instance' }] },
    { code: 'const lazy = (function () { return new Map(); })();', errors: [{ messageId: 'instance' }] },
    { code: 'class Registry { static cache = new Map(); }', errors: [{ messageId: 'instance' }] },
    { code: 'class Registry { static { const m = new Map(); m.clear(); } }', errors: [{ messageId: 'instance' }] },
  ],
});
