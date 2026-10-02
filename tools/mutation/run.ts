// `npm run mutation` (§14, фаза 9): StrykerJS по областям — движок, FSM, расписание, логика сервера — по очереди, на
// command runner с тестами области (areas.ts), потом сводка (summary.ts). Конфиг области — общий stryker.config.json
// плюс mutate, команда и имена отчётов; кладётся в reports/mutation/. Области — аргументы (по умолчанию все):
// `node tools/mutation/run.ts fsm server`. В CI не входит.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AREAS, testCommand } from './areas.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${ROOT}reports/mutation/`;
const asked = process.argv.slice(2);
const unknown = asked.filter((key) => !AREAS.some((area) => area.key === key));
if (unknown.length > 0) throw new Error(`неизвестные области: ${unknown.join(', ')}; есть: ${AREAS.map((area) => area.key).join(', ')}`);
const areas = asked.length === 0 ? AREAS : AREAS.filter((area) => asked.includes(area.key));
const base = JSON.parse(readFileSync(`${ROOT}stryker.config.json`, 'utf8')) as Record<string, unknown>;
mkdirSync(OUT, { recursive: true });

for (const area of areas) {
  const config = {
    ...base,
    mutate: area.mutate,
    commandRunner: { command: testCommand(area) },
    jsonReporter: { fileName: `reports/mutation/${area.key}.json` },
    htmlReporter: { fileName: `reports/mutation/${area.key}.html` },
  };
  const file = `${OUT}stryker.${area.key}.json`;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`\n=== ${area.name}: ${area.mutate.join(' ')}`);
  const run = spawnSync('npx', ['stryker', 'run', file], { cwd: ROOT, stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`StrykerJS упал на области ${area.name} (код ${String(run.status)})`);
}

// Метка сводки — MUTATION_LABEL (before, after; по умолчанию current).
const summary = spawnSync('node', ['tools/mutation/summary.ts', process.env['MUTATION_LABEL'] ?? 'current'], { cwd: ROOT, stdio: 'inherit' });
process.exitCode = summary.status ?? 1;
