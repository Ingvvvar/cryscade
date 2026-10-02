// Счёт мутаций по областям (§14, фаза 9): run.ts гоняет StrykerJS по областям (areas.ts), этот скрипт читает их
// JSON-отчёты (reports/mutation/<область>.json, схема mutation-testing-report-schema) и считает счёт так же, как
// Stryker: (убитые + таймауты) / (они же + выжившие + без покрытия). Эквивалентные мутанты — список с причинами
// (equivalents.json): выживший из списка не пробел в тестах, и счёт без них — второй столбец. Цель 80% — по нему.
// Запись списка, которая не нашла выжившего (мутанта убили — значит, он не эквивалентный) или нашла двух, — ошибка.
// Пишет reports/phase-9/mutation-<метка>.json, выживших без объяснения и эквивалентных. Метка — аргумент
// (по умолчанию current).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AREAS, type Area } from './areas.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${ROOT}reports/phase-9/`;
const TARGET = 80;

interface Mutant {
  readonly mutatorName: string;
  readonly status: string;
  readonly replacement?: string;
  readonly location: { readonly start: { readonly line: number; readonly column: number }; readonly end: { readonly column: number } };
}

interface Report {
  readonly files: Readonly<Record<string, { readonly source: string; readonly mutants: readonly Mutant[] }>>;
}

/**
 * Эквивалентный мутант: файл, строка исходника без отступа (якорь, переживающий сдвиг строк), колонки начала и конца
 * мутанта на ней, мутатор, замена. Строка, которая в файле повторяется, — ещё и nth: номер её вхождения сверху, с 1;
 * у каждого вхождения своя запись и своя причина.
 */
interface Equivalent {
  readonly file: string;
  readonly code: string;
  readonly nth?: number;
  readonly column: number;
  readonly end: number;
  readonly mutator: string;
  readonly replacement: string;
  readonly reason: string;
}

interface Counts {
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  invalid: number;
  equivalent: number;
}

const label = process.argv[2] ?? 'current';
const equivalents = JSON.parse(readFileSync(fileURLToPath(new URL('equivalents.json', import.meta.url)), 'utf8')) as Equivalent[];
const matches = new Map<Equivalent, string[]>(equivalents.map((entry) => [entry, []]));

const counts = new Map(AREAS.map((area) => [area.key, { killed: 0, timeout: 0, survived: 0, noCoverage: 0, invalid: 0, equivalent: 0 } satisfies Counts]));
const missing: string[] = [];
const reported = new Set<string>();
const survivors: string[] = [];
for (const area of AREAS) {
  const file = `${ROOT}reports/mutation/${area.key}.json`;
  if (!existsSync(file)) {
    missing.push(area.name);
    continue;
  }
  const report = JSON.parse(readFileSync(file, 'utf8')) as Report;
  for (const [path, entry] of Object.entries(report.files)) {
    const relative = path.startsWith(ROOT) ? path.slice(ROOT.length) : path;
    if (!area.prefixes.some((prefix) => relative.startsWith(prefix))) continue;
    reported.add(relative);
    tally(area.key, relative, entry.source.split('\n'), entry.mutants);
  }
}

function tally(key: Area['key'], relative: string, lines: readonly string[], mutants: readonly Mutant[]): void {
  const count = counts.get(key);
  if (count === undefined) return;
  for (const mutant of mutants) {
    if (mutant.status === 'Killed') count.killed += 1;
    else if (mutant.status === 'Timeout') count.timeout += 1;
    else if (mutant.status === 'Survived') count.survived += 1;
    else if (mutant.status === 'NoCoverage') count.noCoverage += 1;
    else if (mutant.status !== 'Ignored') count.invalid += 1;
    if (mutant.status !== 'Survived' && mutant.status !== 'NoCoverage') continue;
    const at = `${relative}:${String(mutant.location.start.line)}:${String(mutant.location.start.column)}`;
    const code = (lines[mutant.location.start.line - 1] ?? '').trim();
    // Повторяющуюся строку различает номер вхождения: без него одна запись находила бы мутантов всех вхождений.
    const repeats = lines.filter((line) => line.trim() === code).length > 1;
    const nth = lines.slice(0, mutant.location.start.line).filter((line) => line.trim() === code).length;
    const replacement = (mutant.replacement ?? '').replace(/\s+/g, ' ');
    const entry = equivalents.find(
      (item) =>
        item.file === relative &&
        item.code === code &&
        item.nth === (repeats ? nth : undefined) &&
        item.column === mutant.location.start.column &&
        item.end === mutant.location.end.column &&
        item.mutator === mutant.mutatorName &&
        item.replacement === replacement,
    );
    if (entry !== undefined) {
      matches.get(entry)?.push(at);
      count.equivalent += 1;
    } else {
      survivors.push(`${at} ${mutant.status} ${mutant.mutatorName} → ${replacement.slice(0, 120)}`);
    }
  }
}

const score = (count: Counts, without: number): number => {
  const valid = count.killed + count.timeout + count.survived + count.noCoverage - without;
  return valid === 0 ? 0 : ((count.killed + count.timeout) / valid) * 100;
};

const rows = AREAS.map((area) => {
  const count = counts.get(area.key) ?? { killed: 0, timeout: 0, survived: 0, noCoverage: 0, invalid: 0, equivalent: 0 };
  return { key: area.key, name: area.name, ...count, score: score(count, 0), adjusted: score(count, count.equivalent) };
});
for (const row of rows) {
  console.log(
    `${row.name.padEnd(15)} ${row.score.toFixed(2).padStart(6)}%, без эквивалентных ${row.adjusted.toFixed(2).padStart(6)}%  убито ${String(row.killed)}, таймаут ${String(row.timeout)}, выжило ${String(row.survived)} (эквивалентных ${String(row.equivalent)}), без покрытия ${String(row.noCoverage)}, негодных ${String(row.invalid)}`,
  );
}

// Запись списка по файлу из прогона обязана найти ровно одного выжившего.
const stale = [...matches]
  .filter(([entry, found]) => reported.has(entry.file) && found.length !== 1)
  .map(([entry, found]) => `${entry.file} «${entry.code}»${entry.nth === undefined ? '' : ` (вхождение ${String(entry.nth)})`} ${entry.mutator} → ${entry.replacement}: найдено ${String(found.length)}`);
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}mutation-${label}.json`, `${JSON.stringify({ label, target: TARGET, areas: rows }, null, 2)}\n`);
writeFileSync(`${OUT}mutation-survivors-${label}.txt`, `${survivors.sort().join('\n')}\n`);
writeFileSync(
  `${OUT}mutation-equivalents-${label}.txt`,
  `${[...matches]
    .filter(([, found]) => found.length > 0)
    .map(([entry, found]) => `${found.join(', ')} ${entry.mutator} → ${entry.replacement}: ${entry.reason}`)
    .sort()
    .join('\n')}\n`,
);
if (missing.length > 0) console.error(`нет отчёта: ${missing.join(', ')} — сначала node tools/mutation/run.ts`);
if (stale.length > 0) console.error(`записи эквивалентных без ровно одного выжившего:\n${stale.join('\n')}`);
const below = rows.filter((row) => row.adjusted < TARGET || row.killed + row.timeout + row.survived + row.noCoverage === 0);
if (below.length > 0) console.error(`ниже цели ${String(TARGET)}% (или пусто): ${below.map((row) => row.name).join(', ')}`);
if (missing.length > 0 || stale.length > 0 || below.length > 0) process.exitCode = 1;
