// Числа замеров для общей таблицы §13 (фаза 9): тесты кладут их в reports/phase-9/ простым JSON — отчёт замеров
// (tools/measure/report.ts) собирает таблицу из файлов, а не из лога прогона.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PHASE9 = fileURLToPath(new URL('../../../reports/phase-9/', import.meta.url));

export function writeMeasure(name: string, data: unknown): void {
  mkdirSync(PHASE9, { recursive: true });
  writeFileSync(`${PHASE9}${name}.json`, `${JSON.stringify(data, null, 2)}\n`);
}
