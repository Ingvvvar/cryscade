import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Тестовые крючки только вне прод-сборки (§15, фаза 3). Сборки делает webServer этого конфига:
// dist/ — прод, dist-e2e/ — --mode e2e. Положительный контроль: те же маркеры находятся в dist-e2e/.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MARKERS = ['__cryscadeProbe', 'addControlSprites', 'removeControlSprites', 'renderOnce'];

function scripts(dir: string): { files: number; text: string } {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const full = path.join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|mjs|html)$/.test(entry)) out.push(readFileSync(full, 'utf8'));
    }
  };
  walk(path.join(ROOT, dir));
  return { files: out.length, text: out.join('\n') };
}

const count = (text: string, marker: string): number => text.split(marker).length - 1;

test('прод-бандл без зонда, e2e-бандл с ним', () => {
  const prod = scripts('dist');
  const e2e = scripts('dist-e2e');
  expect(prod.files).toBeGreaterThan(0);
  expect(e2e.files).toBeGreaterThan(0);
  for (const marker of MARKERS) {
    expect(count(e2e.text, marker), `положительный контроль: ${marker} в dist-e2e`).toBeGreaterThan(0);
    expect(count(prod.text, marker), `${marker} в dist`).toBe(0);
  }
});

/** Сборка Vite в test-results/: вывод и код выхода. */
function build(outDir: string, env: Readonly<Record<string, string>>, config: string | null): { status: number | null; output: string } {
  const args = ['vite', 'build', '--mode', 'e2e', '--outDir', `test-results/${outDir}`, '--emptyOutDir', ...(config === null ? [] : ['-c', config])];
  const run = spawnSync('npx', args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

test('гейт бюджета (§13): начальный JS в 300 КБ; ленивый корень, импортированный статически, роняет сборку', () => {
  test.setTimeout(180_000);
  const lazy = build('budget-lazy', {}, null);
  expect(lazy.status).toBe(0);
  const measured = /\[бюджет\] начальный JS: (\d+) Б gzip из 307200/.exec(lazy.output);
  expect(measured, lazy.output).not.toBeNull();
  const initial = Number(measured?.[1]);
  expect(initial).toBeGreaterThan(0);
  expect(initial).toBeLessThanOrEqual(307_200);
  // Положительный контроль: тот же бюджет — начальный JS этой сборки, а зонд — статически. Гейт обязан упасть.
  const eager = build('budget-eager', { CRYSCADE_BUDGET: String(initial), CRYSCADE_STATIC_ROOT: './probe.ts' }, 'vite.budget-control.config.ts');
  expect(eager.status).not.toBe(0);
  expect(eager.output).toMatch(new RegExp(`начальный JS \\d+ Б gzip больше бюджета ${String(initial)} Б`));
  // И без статического импорта тот же контрольный конфиг на том же бюджете проходит: падение — от зонда, не от конфига.
  const same = build('budget-same', { CRYSCADE_BUDGET: String(initial) }, 'vite.budget-control.config.ts');
  expect(same.status, same.output).toBe(0);
});

