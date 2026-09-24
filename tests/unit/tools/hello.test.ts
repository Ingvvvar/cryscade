import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('node запускает tools/hello.ts без tsx и печатает название из core/', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const stdout = execFileSync(process.execPath, ['tools/hello.ts'], { cwd: root, encoding: 'utf8' });
  expect(stdout).toBe('Cryscade\n');
});
