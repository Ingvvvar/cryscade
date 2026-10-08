// Таблица замеров §13 (фаза 9): `npm run measure` сначала гоняет tests/measure (время кадра, память за 300 спинов),
// потом этот скрипт собирает reports/phase-9/measure.md из чисел, которые тесты положили в reports/phase-9/*.json,
// draw-call — из последнего прогона `npm run shots` (те же папки), начальный JS — из гейта прод-сборки в test-results/,
// книга — по размеру .gz. Нет файла — строка «нет данных» с командой, а не выдуманное число.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIR = `${ROOT}reports/phase-9/`;
const TAGS = ['idle', 'cascade', 'feature', 'bigWin'] as const;
const TAG_NAMES: Readonly<Record<(typeof TAGS)[number], string>> = { idle: 'покой', cascade: 'каскад', feature: 'фича', bigWin: 'большой выигрыш' };
const RENDERERS = ['webgl', 'webgpu'] as const;

interface TagStats {
  readonly frames: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly over60: number;
}

interface Frames {
  readonly gpu: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly dpr: number;
  readonly runs: number;
  readonly worst: Readonly<Record<(typeof TAGS)[number], TagStats>>;
  readonly atlas: { readonly width: number; readonly height: number };
}

interface Side {
  readonly objects: number;
  readonly used: number;
}

interface Heaps {
  readonly page: Side;
  readonly worker: Side;
  readonly liveTextures: number;
  readonly liveContexts: number;
}

interface Memory {
  readonly gpu: string;
  readonly spins: readonly [number, number];
  readonly at50: Heaps;
  readonly at300?: Heaps;
  readonly at150?: Heaps;
}

interface IdleDraws {
  readonly gpu: string;
  readonly idle: number;
}

interface FrameDraws {
  readonly gpu: string;
  readonly frames: number;
  readonly cascade: { readonly draws: number };
  readonly bigWin: { readonly draws: number };
}

/** Числа замера из reports/phase-9/; файла нет — null. Форма — та, что пишут тесты (writeMeasure). */
function read(name: string): unknown {
  const file = `${DIR}${name}.json`;
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : null;
}

const ms = (value: number): string => value.toFixed(2);
const mb = (bytes: number): string => (bytes / 1_048_576).toFixed(2);
const pct = (from: number, to: number): string => `${to >= from ? '+' : ''}${((to / from - 1) * 100).toFixed(2)}%`;
const bytes = (value: number): string => value.toLocaleString('ru-RU').replace(/[\u00a0\u202f]/g, ' ');

/** Начальный JS прод-сборки — строкой гейта; сборка в test-results/, dist/ не трогается. */
function initialJs(): string {
  const run = spawnSync('npx', ['vite', 'build', '--outDir', 'test-results/measure-build', '--emptyOutDir'], { cwd: ROOT, encoding: 'utf8' });
  const line = /\[бюджет\] начальный JS: (\d+) Б gzip из (\d+) \(страница (\d+), воркеры (\d+)\)/.exec(`${run.stdout}${run.stderr}`);
  if (run.status !== 0 || line === null) return 'нет данных: прод-сборка не прошла';
  return `${bytes(Number(line[1]))} Б gzip (страница ${bytes(Number(line[3]))}, воркер ${bytes(Number(line[4]))})`;
}

function book(): string {
  const dir = `${ROOT}public/books/`;
  const file = readdirSync(dir).find((name) => name.endsWith('.gz'));
  return file === undefined ? 'нет данных' : `${bytes(statSync(`${dir}${file}`).size)} Б gzip (${file})`;
}

function drawCalls(): string {
  const parts = RENDERERS.map((renderer) => {
    const idle = read(`draw-calls-idle-${renderer}`) as IdleDraws | null;
    const frames = read(`draw-calls-frames-${renderer}`) as FrameDraws | null;
    if (idle === null || frames === null) return `${renderer}: нет данных — npm run shots`;
    return `${renderer}: ${String(idle.idle)} / ${String(frames.cascade.draws)} / ${String(frames.bigWin.draws)}`;
  });
  return parts.join('; ');
}

function frameTable(renderer: (typeof RENDERERS)[number]): string[] {
  const frames = read(`frames-${renderer}`) as Frames | null;
  if (frames === null) return [`${renderer}: нет данных — npm run measure`, ''];
  return [
    `**${renderer}** — ${frames.gpu}; ${String(frames.viewport.width)} × ${String(frames.viewport.height)}, DPR ${String(frames.dpr)}; худшее из ${String(frames.runs)} прогонов, мс.`,
    '',
    '| Что на сцене | Кадров (наименьшее) | p50 | p95 | p99 | max | Длиннее 16.7 мс |',
    '|---|---|---|---|---|---|---|',
    ...TAGS.map((tag) => {
      const s = frames.worst[tag];
      return `| ${TAG_NAMES[tag]} | ${String(s.frames)} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${ms(s.max)} | ${String(s.over60)} |`;
    }),
    '',
  ];
}

function memoryRows(): string[] {
  const rows: string[] = [];
  for (const renderer of RENDERERS) {
    const run = read(`memory-${renderer}`) as Memory | null;
    const control = read(`memory-control-${renderer}`) as Memory | null;
    if (run?.at300 !== undefined) {
      const { at50, at300 } = run;
      rows.push(
        `| ${renderer} | 50 → 300 | ${mb(at50.page.objects)} → ${mb(at300.page.objects)} (${pct(at50.page.objects, at300.page.objects)}) | ${mb(at50.worker.objects)} → ${mb(at300.worker.objects)} (${pct(at50.worker.objects, at300.worker.objects)}) | ${String(at50.liveTextures)} → ${String(at300.liveTextures)} | ${String(at50.liveContexts)} → ${String(at300.liveContexts)} | ${mb(at50.page.used)} → ${mb(at300.page.used)} (${pct(at50.page.used, at300.page.used)}) | ${mb(at50.worker.used)} → ${mb(at300.worker.used)} (${pct(at50.worker.used, at300.worker.used)}) |`,
      );
    } else {
      rows.push(`| ${renderer} | нет данных — npm run measure | | | | | | |`);
    }
    if (control?.at150 !== undefined) {
      const { at50, at150 } = control;
      rows.push(
        `| ${renderer}, контроль ?memleak=1 | 50 → 150 | ${mb(at50.page.objects)} → ${mb(at150.page.objects)} (${pct(at50.page.objects, at150.page.objects)}) | ${mb(at50.worker.objects)} → ${mb(at150.worker.objects)} (${pct(at50.worker.objects, at150.worker.objects)}) | ${String(at50.liveTextures)} → ${String(at150.liveTextures)} | ${String(at50.liveContexts)} → ${String(at150.liveContexts)} | ${mb(at50.page.used)} → ${mb(at150.page.used)} | ${mb(at50.worker.used)} → ${mb(at150.worker.used)} |`,
      );
    }
  }
  return rows;
}

function memorySummary(): string {
  const parts = RENDERERS.map((renderer) => {
    const run = read(`memory-${renderer}`) as Memory | null;
    if (run?.at300 === undefined) return `${renderer}: нет данных`;
    const { at50, at300 } = run;
    return `${renderer}: страница ${pct(at50.page.objects, at300.page.objects)}, воркер ${pct(at50.worker.objects, at300.worker.objects)}, текстур ${String(at50.liveTextures)} → ${String(at300.liveTextures)}, GraphicsContext ${String(at50.liveContexts)} → ${String(at300.liveContexts)}`;
  });
  return parts.join('; ');
}

function frameSummary(): string {
  const parts = RENDERERS.map((renderer) => {
    const frames = read(`frames-${renderer}`) as Frames | null;
    if (frames === null) return `${renderer}: нет данных`;
    const worst = Math.max(...TAGS.map((tag) => frames.worst[tag].p95));
    return `${renderer}: p95 худшего состояния ${ms(worst)} мс`;
  });
  return parts.join('; ');
}

function atlas(): string {
  const frames = (read('frames-webgl') ?? read('frames-webgpu')) as Frames | null;
  return frames === null ? 'нет данных — npm run measure' : `${String(frames.atlas.width)} × ${String(frames.atlas.height)} (PNG атласа из зонда)`;
}

const lines = [
  '# Замеры §13 — фаза 9',
  '',
  'Команда — `npm run measure`: tests/measure (время кадра изнутри кадра, память за 300 спинов) на e2e-сборке и настоящем',
  'GPU, потом tools/measure/report.ts. Draw-call — из `npm run shots` (потолки-храповик). На программном рендере тесты',
  'мерить отказываются. Порог времени кадра ставит телефон — проверка владельца (§16).',
  '',
  '## Сводка',
  '',
  '| Что | Бюджет §13 | Замер |',
  '|---|---|---|',
  `| draw-call: покой / каскад и фича / большой выигрыш | WebGL ≤ 15 / ≤ 25 / ≤ 35 | ${drawCalls()} |`,
  `| начальный JS без книги | ≤ 300 КБ gzip (307 200 Б), вместе с воркером | ${initialJs()} |`,
  `| книга | ≤ 1 МБ gzip, лениво | ${book()}; лениво — e2e loadBook (fairness.spec) |`,
  `| атлас | ≤ 2048 × 2048 | ${atlas()} |`,
  '| аллокации в sampleScene | 0 | 0 — tests/unit/presentation/sample-alloc.test.ts |',
  `| память за 300 спинов: объекты кучи страницы и воркера ≤ +5% к 50-му, живых текстур и GraphicsContext не больше | ≤ +5%, не больше | ${memorySummary()} |`,
  `| кадр — без подёргиваний на телефоне | проверка владельца | ${frameSummary()} (стенд — не телефон) |`,
  '',
  '## Время кадра',
  '',
  'Изнутри кадра: от первого слушателя тикера приложения до последнего — после render Pixi. Сцена: 3 с покоя, каскад',
  '(сид 512), фича (48; плашка — тапом через секунду), большой выигрыш 72× (1590) и кап (801200: до празднования — тапами).',
  'Метка кадра — по показу. Контроль инструмента: 4 мс работы в каждом кадре — медиана покоя не меньше 4 мс.',
  '',
  ...frameTable('webgl'),
  ...frameTable('webgpu'),
  '## Память за 300 спинов',
  '',
  'Турбо и автопропуск; первые восемь спинов — принудительные крупные раунды, первый — самый длинный каскад книги (пулы —',
  'до верха до отметки 50). Объекты кучи — по снимку V8 после сборки: достижимое от корней, без кода JIT и внутренних',
  'кэшей движка (tests/measure/heap-objects.ts); usedSize — сырая куча (Runtime.getHeapUsage), её рост — прогрев JIT.',
  'Живые текстуры — созданные минус удалённые на границе API WebGL и WebGPU; живые GraphicsContext — созданные минус',
  'уничтоженные на границе API Pixi (счётчик зонда сцены). Проверка: объекты ≤ +5%, живых текстур и GraphicsContext не',
  'больше; контроль ?memleak=1 — все четыре проверки краснеют.',
  '',
  '| Рендерер | Спины | Объекты страницы, МБ | Объекты воркера, МБ | Живые текстуры | Живые GraphicsContext | usedSize страницы, МБ | usedSize воркера, МБ |',
  '|---|---|---|---|---|---|---|---|',
  ...memoryRows(),
  '',
];

writeFileSync(`${DIR}measure.md`, `${lines.join('\n')}\n`);
console.log(`отчёт: ${DIR}measure.md`);
