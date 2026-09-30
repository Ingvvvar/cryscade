import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Тестовые крючки только вне прод-сборки (§15, фаза 3). Сборки делает webServer этого конфига:
// dist/ — прод, dist-e2e/ — --mode e2e. Положительный контроль: те же маркеры находятся в dist-e2e/.
// Фаза 5: канал зонда cryscade-probe — принудительный раунд в воркере и его сиды; в проде ни страница, ни воркер его не знают.
// Флаги зонда ?autoskip и ?warmup=off — только в dev и e2e, как сам зонд.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MARKERS = ['__cryscadeProbe', 'addControlSprites', 'removeControlSprites', 'renderOnce', 'cryscade-probe', 'forceRoundAck', 'autoskip', 'warmup'];

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

const CONTROL = 'vite.budget-control.config.ts';

/** Сборка Vite в test-results/: вывод и код выхода. Переменные контроля — только из env: свои из окружения не наследуются. */
function build(outDir: string, env: Readonly<Record<string, string>>, config: string | null): { status: number | null; output: string } {
  const args = ['vite', 'build', '--mode', 'e2e', '--outDir', `test-results/${outDir}`, '--emptyOutDir', ...(config === null ? [] : ['-c', config])];
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CRYSCADE_')));
  const run = spawnSync('npx', args, { cwd: ROOT, env: { ...inherited, ...env }, encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

test('гейт бюджета (§13): начальный JS в 300 КБ; ленивый модуль в начальном JS, лишний байт и порог не числом роняют сборку', () => {
  test.setTimeout(300_000);
  const normal = build('budget-normal', {}, null);
  expect(normal.status, normal.output).toBe(0);
  const measured = /\[бюджет\] начальный JS: (\d+) Б gzip из 307200/.exec(normal.output);
  expect(measured, normal.output).not.toBeNull();
  const initial = Number(measured?.[1]);
  expect(initial).toBeGreaterThan(0);
  expect(initial).toBeLessThanOrEqual(307_200);
  // Ленивый модуль: зонд статически при реальном пороге — до 300 КБ далеко, а сборка обязана упасть, назвав модуль.
  const eager = build('budget-eager', { CRYSCADE_BUDGET: '307200', CRYSCADE_STATIC_ROOT: './probe.ts' }, CONTROL);
  expect(eager.status).not.toBe(0);
  expect(eager.output).toMatch(/ленивый модуль в начальном JS — его место за динамическим импортом \(§13\): src\/ui\/probe\.ts в /);
  expect(eager.output).not.toMatch(/больше бюджета/);
  // Тот же контрольный конфиг при том же пороге без статического импорта проходит: падение — от зонда, не от конфига.
  const same = build('budget-same', { CRYSCADE_BUDGET: '307200' }, CONTROL);
  expect(same.status, same.output).toBe(0);
  expect(same.output).toContain(`[бюджет] начальный JS: ${String(initial)} Б gzip из 307200`);
  // Размер: порог на байт меньше начального JS — падение по размеру.
  const over = build('budget-over', { CRYSCADE_BUDGET: String(initial - 1) }, CONTROL);
  expect(over.status).not.toBe(0);
  expect(over.output).toMatch(new RegExp(`начальный JS ${String(initial)} Б gzip больше бюджета ${String(initial - 1)} Б`));
  // Порог не числом: переменной нет — ошибка сборки с понятным сообщением, а не NaN и молчаливый пропуск.
  const unset = build('budget-unset', {}, CONTROL);
  expect(unset.status).not.toBe(0);
  expect(unset.output).toContain('бюджет начального JS — безопасное целое больше нуля, байт gzip; получено NaN');
});

