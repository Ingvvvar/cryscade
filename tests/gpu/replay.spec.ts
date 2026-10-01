import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import type { ControllerSnapshot } from '../../src/client/index.ts';
import { sceneInfo, type ProbeWindow } from '../support/page-probe.ts';
import { PINNED_AMBIENT_S, snapshot } from './support/frame.ts';

// Повтор по ссылке (фаза 6) — владельцу на глаз, в reports/phase-6/ с индексом «что смотреть»: плашка «Повтор раунду» с
// выходом, панель без баланса и со ставкой записи, спин выключен; плашка фриспинов в повторе; экран «повтору нет».
// Часы Playwright: показ идёт сам до нужного состояния, потом время стоит, декор закреплён. На программном рендере не снимаем.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${ROOT}reports/phase-6/`;
/** Последняя запись книги — кап 5000×: фриспины, ретриггеры. */
const CAP = 58_353;

interface Moment {
  readonly file: string;
  readonly title: string;
  readonly look: string;
  readonly query: string;
  /** До какого состояния машины дойти перед снимком. */
  readonly until: ControllerSnapshot['state'];
}

const MOMENTS: readonly Moment[] = [
  {
    file: 'replay-held',
    title: 'Повтор записи книги: плашка фриспинов',
    look: 'сверху — плашка «Повтор раунду» с выходом «Грати»; плашка «Фріспіни» ждёт тапа, как в игре; баланс «—», ставка 1,00, «Спін» выключен',
    query: `?replay=book:${String(CAP)}`,
    until: { name: 'replaying', stage: 'held', roundId: `book-${String(CAP)}` },
  },
  {
    file: 'replay-done',
    title: 'Повтор записи книги: показ окончен',
    look: 'итог 5000,00 в зоне выигрыша, итоговая сетка; плашка «Повтор раунду» остаётся, спина нет — выход только ссылкой',
    query: `?replay=book:${String(CAP)}&autoskip=1`,
    until: { name: 'replaying', stage: 'done', roundId: `book-${String(CAP)}` },
  },
  {
    file: 'replay-missing',
    title: 'Ссылка в никуда: раунда нет в истории браузера',
    look: 'экран «За цим посиланням повтору немає…» с кнопкой «Грати» (не «Перезавантажити»: та же ссылка дала бы ту же ошибку)',
    query: '?replay=round:zz9',
    until: { name: 'error', kind: 'missing', retry: null, holdsLock: false },
  },
];

const FRAMES = {
  landscape: { viewport: { width: 1440, height: 900 }, dpr: 2 },
  portrait: { viewport: { width: 390, height: 844 }, dpr: 3 },
} as const;

interface Shot {
  readonly file: string;
  readonly title: string;
  readonly look: string;
  readonly renderer: string;
  readonly gpu: string;
}

const shots: Shot[] = [];

async function reach(page: Page, state: ControllerSnapshot['state']): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.game()?.state ?? null), { timeout: 30_000, message: `нет ${state.name}` })
    .toStrictEqual(state);
}

async function shoot(browser: Browser, frame: keyof typeof FRAMES): Promise<void> {
  const { viewport, dpr } = FRAMES[frame];
  for (const moment of MOMENTS) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await page.clock.install({ time: 0 });
    await page.goto(`./${moment.query}&renderer=webgl`);
    await reach(page, moment.until);
    await page.clock.pauseAt(120_000);
    await page.evaluate((seconds) => {
      (window as ProbeWindow).__cryscadeProbe?.pinAmbient(seconds);
    }, PINNED_AMBIENT_S);
    await page.clock.runFor(1000);
    const info = await sceneInfo(page);
    expect(info.name, 'фактический рендерер').toBe('webgl');
    expect(info.software, `программный рендер: ${info.gpu}`).toBe(false);
    const { png } = await snapshot(page);
    const file = `${moment.file}-${frame}-webgl.png`;
    writeFileSync(`${OUT}${file}`, png);
    shots.push({ file, title: moment.title, look: moment.look, renderer: info.name, gpu: info.gpu });
    await context.close();
  }
}

mkdirSync(OUT, { recursive: true });

test('ландшафт, WebGL: повтор и ссылка в никуда', async ({ browser }) => {
  test.setTimeout(120_000);
  await shoot(browser, 'landscape');
});

test('портрет, WebGL: повтор и ссылка в никуда', async ({ browser }) => {
  test.setTimeout(120_000);
  await shoot(browser, 'portrait');
});

test.afterAll(() => {
  const rows = shots.map((shot) => `| [${shot.file}](${shot.file}) | ${shot.title} | ${shot.look} | ${shot.renderer} |`);
  const index = [
    '# Фаза 6 — повтор по ссылке: что смотреть',
    '',
    'Снимки — `npm run shots` (`tests/gpu/replay.spec.ts`). Показ идёт до нужного состояния, потом часы Playwright стоят,',
    `декор закреплён. GPU: ${shots[0]?.gpu ?? '—'}.`,
    '',
    '| Снимок | Момент | Что смотреть | Рендерер |',
    '|---|---|---|---|',
    ...rows,
    '',
    'Руками: `npm run dev`, сыграть раунд, открыть `?replay=round:<id раунда>` (id — DevTools → Application → IndexedDB →',
    `cryscade → rounds) и \`?replay=book:${String(CAP)}\`; проверка раунда — \`docs/fairness.md\`, отчёт по книге — \`docs/math.md\`.`,
    '',
  ].join('\n');
  writeFileSync(`${OUT}index.md`, index);
});
