import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { sceneInfo, waitSettled, type ProbeWindow } from '../support/page-probe.ts';
import { emulate, idle, settle } from '../support/touch-page.ts';
import { PINNED_AMBIENT_S } from './support/frame.ts';

// Нажатое каждой кнопки (прогон №6) — владельцу на глаз, в reports/mobile/: маленький телефон, большой и планшет —
// Android (Chromium) и iPhone/iPad (WebKit), портрет. В листе у каждой кнопки слева покой, справа нажатая. Нажатие —
// мышью: :active тот же, что от пальца, а отпускание мимо кнопки клика не даёт (удержать касание WebKit Playwright не
// умеет). Подсветку касания браузера инструмент не рисует (проба прогона №6) — в снимках её нет ни до, ни после.
// Декор закреплён; на программном рендере не снимаем.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${ROOT}reports/mobile/`;

const SCREENS = [
  ['Android', 'Galaxy S5', 'маленький телефон'],
  ['Android', 'Pixel 9 Pro XL', 'большой телефон'],
  ['Android', 'Galaxy Tab S9', 'планшет'],
  ['iOS', 'iPhone SE (3rd gen)', 'маленький телефон'],
  ['iOS', 'iPhone 17 Pro Max', 'большой телефон'],
  ['iOS', 'iPad (gen 11)', 'планшет'],
] as const;

interface Tile {
  readonly name: string;
  readonly width: number;
  readonly rest: string;
  readonly pressed: string;
}

/** Сведения листа для index.md: каждый тест пишет свой файл, индекс собирается из всех. */
interface Sheet {
  readonly file: string;
  readonly title: string;
  readonly gpu: string;
  readonly count: number;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Кнопка в покое и нажатая: снимок рамки кнопки с полями 16 px; отпускание — в угол страницы, мимо кнопки. */
async function capture(page: Page, target: Locator, name: string, tiles: Tile[]): Promise<void> {
  if (await target.evaluate((element) => element.closest('dialog, [popover]') !== null)) await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error(`нет «${name}»`);
  const size = page.viewportSize();
  if (size === null) throw new Error('нет размера окна');
  const x = Math.max(0, Math.floor(box.x - 16));
  const y = Math.max(0, Math.floor(box.y - 16));
  const clip = { x, y, width: Math.min(size.width, Math.ceil(box.x + box.width + 16)) - x, height: Math.min(size.height, Math.ceil(box.y + box.height + 16)) - y };
  const rest = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  const cx = Math.min(Math.max(box.x + box.width / 2, 1), size.width - 1);
  const cy = Math.min(Math.max(box.y + box.height / 2, 1), size.height - 1);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await expect.poll(() => target.evaluate((element) => element.matches(':active'))).toBe(true);
  await page.waitForTimeout(150);
  const pressed = await page.screenshot({ clip, caret: 'hide' });
  await page.mouse.move(2, 2);
  await page.mouse.up();
  tiles.push({ name, width: clip.width, rest: `data:image/png;base64,${rest.toString('base64')}`, pressed: `data:image/png;base64,${pressed.toString('base64')}` });
}

/** Каждая видимая кнопка набора — по очереди. */
async function captureAll(page: Page, scope: Locator, tiles: Tile[], least: number): Promise<void> {
  const controls = scope.locator(':is(button, a[href], label.choice):visible');
  const count = await controls.count();
  expect(count).toBeGreaterThanOrEqual(least);
  for (let at = 0; at < count; at++) {
    const control = controls.nth(at);
    if (await control.isDisabled().catch(() => false)) continue;
    const name = ((await control.getAttribute('aria-label')) ?? (await control.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    await capture(page, control, name, tiles);
  }
}

/** Листы «до и после» (compare-*.png с подписью в compare-*.txt) — их снимает проба прогона №6 на сборке до правки. */
function compares(): string[] {
  const files = readdirSync(OUT)
    .filter((file) => file.startsWith('compare-') && file.endsWith('.png') && existsSync(`${OUT}${file.replace(/\.png$/, '.txt')}`))
    .sort();
  if (files.length === 0) return [];
  return [
    '## До правки (`d5aa424`) и после — те же действия',
    '',
    ...files.flatMap((file) => {
      const [title = file, look = ''] = readFileSync(`${OUT}${file.replace(/\.png$/, '.txt')}`, 'utf8').split('\n');
      return [`### ${title}`, '', look, '', `![${title}](${file})`, ''];
    }),
  ];
}

function writeIndex(): void {
  const sheets = readdirSync(OUT)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(`${OUT}${file}`, 'utf8')) as Sheet)
    .sort((a, b) => a.title.localeCompare(b.title));
  const lines = [
    '# Телефон: нажатое каждой кнопки (прогон №6)',
    '',
    'Снимки — `npx playwright test -c playwright.gpu.config.ts tests/gpu/touch-shots.spec.ts` (e2e-сборка, настоящий GPU,',
    'декор закреплён). В листе у каждой кнопки: слева — покой, справа — нажатая. Нажатие — мышью: `:active` тот же, что от',
    'пальца; отпускание — мимо кнопки, клика нет.',
    '',
    'Что смотреть:',
    '- нажатая кнопка темнее и чуть меньше — и той же формы: у «Спін» — круг, квадрата вокруг нет; у скруглённых — то же',
    '  скругление, без прямоугольника поверх;',
    '- рядом с кнопкой в нажатом снимке ничего не появилось (подсветка, рамка, выделение текста);',
    '- радио и флажки в диалогах: нажатие — у всей строки выбора;',
    '- подсветку касания браузера (голубой прямоугольник Android, тёмный — iOS) инструмент не рисует ни до, ни после: её',
    '  нет в снимках вообще — смотреть на телефоне (первый пункт «Ждёт меня»).',
    '',
    ...sheets.flatMap((sheet) => [`## ${sheet.title}`, '', `Кнопок: ${String(sheet.count)}. GPU: ${sheet.gpu}.`, '', `![${sheet.title}](${sheet.file})`, '']),
    ...compares(),
  ];
  writeFileSync(`${OUT}index.md`, `${lines.join('\n')}\n`);
}

mkdirSync(OUT, { recursive: true });

for (const [platform, device, kind] of SCREENS) {
  test.describe(`${platform} · ${device} · ${kind}`, () => {
    test.use(emulate(device, 'портрет'));

    test('нажатое каждой кнопки: панель, popover, диалоги', async ({ page, browser }) => {
      test.setTimeout(300_000);
      await page.goto('./?renderer=webgl');
      await idle(page);
      const info = await sceneInfo(page);
      expect(info.software, `программный рендер: ${info.gpu}`).toBe(false);
      // Раунд и новый секрет: в истории — «Перевірити» и «Відтворити».
      await page.getByRole('button', { name: 'Спін', exact: true }).click();
      await settle(page);
      await waitSettled(page);
      await page.evaluate((seconds) => {
        (window as ProbeWindow).__cryscadeProbe?.pinAmbient(seconds);
      }, PINNED_AMBIENT_S);
      const tiles: Tile[] = [];
      await captureAll(page, page.locator('.panel .zone'), tiles, 9);
      await page.getByRole('button', { name: 'Меню' }).click();
      await captureAll(page, page.getByTestId('menu'), tiles, 5);
      await page.keyboard.press('Escape');
      await page.getByTestId('bet').click();
      await captureAll(page, page.getByTestId('bet-levels'), tiles, 9);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Авто' }).click();
      await captureAll(page, page.getByTestId('autoplay'), tiles, 7);
      await page.keyboard.press('Escape');
      for (const item of ['Правила і виплати', 'Налаштування', 'Чесність', 'Історія', 'Лабораторія мережі']) {
        await page.getByRole('button', { name: 'Меню' }).click();
        await page.getByTestId('menu').getByRole('button', { name: item }).click();
        const dialog = page.getByRole('dialog', { name: item });
        await expect(dialog).toBeVisible();
        if (item === 'Чесність') {
          await expect(dialog.getByTestId('commitment')).toBeVisible();
          await dialog.getByRole('button', { name: 'Новий секрет' }).click();
          await expect(dialog.getByTestId('revealed')).toBeVisible();
        }
        if (item === 'Історія') await expect(dialog.getByRole('button', { name: 'Перевірити' }).first()).toBeVisible();
        await captureAll(page, dialog, tiles, 1);
        await page.keyboard.press('Escape');
        await expect(page.locator('dialog')).toHaveCount(0);
      }
      const title = `${platform} · ${device} — ${kind}`;
      const file = `${slug(`${platform}-${device}`)}.png`;
      const sheet = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
      const figures = tiles
        .map((tile) => `<figure><figcaption>${tile.name}</figcaption><div class="pair"><img src="${tile.rest}" width="${String(tile.width)}"><img src="${tile.pressed}" width="${String(tile.width)}"></div></figure>`)
        .join('');
      await sheet.setContent(
        `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:20px;background:#050814;color:#eef3ff;font:14px system-ui,sans-serif}h1{margin:0 0 16px;font-size:20px}.grid{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}figure{margin:0;padding:10px;background:#0b1230;border-radius:10px}figcaption{margin-bottom:8px;color:#8a97c4;max-width:520px}.pair{display:flex;gap:8px;align-items:center}img{display:block;height:auto;max-width:300px}</style><h1>${title} — слева покой, справа нажатая</h1><div class="grid">${figures}</div>`,
      );
      await sheet.screenshot({ path: `${OUT}${file}`, fullPage: true });
      await sheet.close();
      writeFileSync(`${OUT}${slug(`${platform}-${device}`)}.json`, JSON.stringify({ file, title, gpu: info.gpu, count: tiles.length } satisfies Sheet));
      writeIndex();
      console.log(`${title}: кнопок ${String(tiles.length)}, лист ${file}`);
    });
  });
}
