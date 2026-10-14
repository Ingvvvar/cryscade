import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { checkTargets, coveredBy, emulate, focusRing, hygiene, idle, rings, settle, shippedCss, tap, tapHighlights, tapScene, type Orientation, type TargetCheck } from '../support/touch-page.ts';

// Телефон (§11, прогон №6): вокруг кнопок при касании проступал прямоугольник — подсветка касания браузера (Chromium
// рисует её со скруглением 3 px поверх круглой «Спін»), рамка фокуса, которую WebKit ставит после касания на первый
// элемент диалога, и выделение «Спін» долгим нажатием. Здесь — каждая кнопка панели, popover, полосы автоигры, диалогов
// и повтора на телефонах и планшетах с касаниями, портрет и ландшафт: проект touch — Chromium как Android, touch-webkit —
// WebKit как iPhone. Только DOM, без зонда: тот же тест идёт на живом адресе. Подсветку браузера инструмент не рисует
// (проба: заведомо красная во время нажатия не попала ни в один снимок) — она проверяется вычисленным стилем.

const ANDROID = ['Galaxy S5', 'Pixel 7', 'Pixel 9 Pro XL', 'Galaxy Tab S9'] as const;
const IOS = ['iPhone SE (3rd gen)', 'iPhone 15', 'iPhone 17 Pro Max', 'iPad (gen 11)'] as const;
const ORIENTATIONS: readonly Orientation[] = ['портрет', 'ландшафт'];

/**
 * Кому можно blocked — всё свободное место квадрата их, а 44 × 44 не набрать. Никому: прогон №6 разрешал ставку в
 * портрете и «Поповнити» в ландшафте, прогон №7 дал им место раскладкой. small не разрешён никому.
 */
const BLOCKED: Readonly<Record<Orientation, readonly string[]>> = { портрет: [], ландшафт: [] };

const CONTROLS = ':is(button, a[href], label.choice, input.text-input)';

/** Касание по элементу; after — дождаться, что касание сделало; потом рамки фокуса нет ни у чего. */
async function press(page: Page, target: Locator, after: () => Promise<void>): Promise<void> {
  await tap(page, target);
  await after();
  expect(await rings(page), 'рамка после касания').toStrictEqual([]);
}

/** Область нажатия набора: найдено не меньше least, проблем нет; что заслонено — разрешено списком BLOCKED. */
async function targets(page: Page, selector: string, scrolled: boolean, orientation: Orientation, least: number): Promise<string[]> {
  const result = await checkTargets(page, selector, scrolled, BLOCKED[orientation]);
  expect(result.count, `${selector}: найдено`).toBeGreaterThanOrEqual(least);
  expect(result.problems, selector).toStrictEqual([]);
  return result.blocked;
}

/**
 * Первый фокус диалога, открытого с клавиатуры, — как до прогона №7: элемент с data-autofocus, а в «Чесності» и
 * «Історії» — «×»: их поле и таблица приходят запросом, когда фокус уже стоит.
 */
const KEYBOARD_FIRST: Readonly<Record<string, (dialog: Locator) => Locator>> = {
  'Правила і виплати': (dialog) => dialog.locator('.rules'),
  'Налаштування': (dialog) => dialog.getByRole('radio', { name: 'Українська' }),
  'Чесність': (dialog) => dialog.getByRole('button', { name: 'Закрити' }),
  'Лабораторія мережі': (dialog) => dialog.getByLabel('Затримка, мс'),
  'Історія': (dialog) => dialog.getByRole('button', { name: 'Закрити' }),
};

/** Диалог из меню касаниями; ready — дождаться содержимого (история и честность грузятся запросом), потом — область. */
async function openDialog(page: Page, item: string, orientation: Orientation, least: number, ready?: (dialog: Locator) => Promise<void>): Promise<Locator> {
  const menu = page.getByTestId('menu');
  await press(page, page.getByRole('button', { name: 'Меню' }), () => expect(menu).toBeVisible());
  const dialog = page.getByRole('dialog', { name: item });
  await press(page, menu.getByRole('button', { name: item }), () => expect(dialog).toBeVisible());
  // Открыт касанием — фокус на самом диалоге: поле в фокусе открыло бы клавиатуру телефона (прогон №7).
  await expect(dialog, `${item}: фокус после касания — сам диалог`).toBeFocused();
  await ready?.(dialog);
  await expect(dialog, `${item}: фокус после загрузки — сам диалог`).toBeFocused();
  await targets(page, `dialog[open] ${CONTROLS}`, true, orientation, least);
  return dialog;
}

async function closeDialog(page: Page, dialog: Locator): Promise<void> {
  await press(page, dialog.getByRole('button', { name: 'Закрити' }), async () => {
    await expect(page.locator('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Меню' })).toBeFocused();
  });
}

/** Каждая кнопка панели, popover, полосы автоигры, диалогов и повтора — касанием; область нажатия — по наборам. */
async function touchTour(page: Page, orientation: Orientation): Promise<string[]> {
  const blocked: string[] = [];
  blocked.push(...(await targets(page, '.zone button', false, orientation, 9)));
  // Сумма баланса — не область «Поповнити»: кнопка возвращает 1000, промах по числу её не жмёт.
  const balance = await coveredBy(page, '[data-testid="balance"]', '.refill');
  expect(balance.points, 'точки суммы баланса').toBeGreaterThan(100);
  expect(balance.hits, 'точки суммы баланса — область «Поповнити»').toBe(0);
  // «Спін» — круглый button, и нажатие — тот же круг: углы её квадрата получает сцена, а не кнопка.
  const corners = await page.getByRole('button', { name: 'Спін', exact: true }).evaluate((spin) => {
    const box = spin.getBoundingClientRect();
    return [
      [box.left + 3, box.top + 3],
      [box.right - 3, box.top + 3],
      [box.left + 3, box.bottom - 3],
      [box.right - 3, box.bottom - 3],
    ].map(([x = 0, y = 0]) => document.elementFromPoint(x, y)?.closest('button') === spin);
  });
  expect(corners, 'углы квадрата «Спін»').toStrictEqual([false, false, false, false]);
  const sound = page.getByRole('button', { name: 'Звук' });
  await press(page, sound, () => expect(sound).toHaveAttribute('aria-pressed', 'false'));
  await press(page, sound, () => expect(sound).toHaveAttribute('aria-pressed', 'true'));
  const turbo = page.getByRole('button', { name: 'Турбо' });
  await press(page, turbo, () => expect(turbo).toHaveAttribute('aria-pressed', 'true'));
  await press(page, turbo, () => expect(turbo).toHaveAttribute('aria-pressed', 'false'));
  const bet = page.getByTestId('bet');
  await press(page, page.getByRole('button', { name: 'Збільшити ставку' }), () => expect(bet).toHaveText('2,00'));
  await press(page, page.getByRole('button', { name: 'Зменшити ставку' }), () => expect(bet).toHaveText('1,00'));
  await press(page, page.getByRole('button', { name: 'Поповнити' }), () => idle(page));
  const levels = page.getByTestId('bet-levels');
  await press(page, bet, () => expect(levels).toBeVisible());
  blocked.push(...(await targets(page, '[data-testid="bet-levels"] button', true, orientation, 9)));
  await press(page, levels.getByRole('button', { name: '2,00', exact: true }), async () => {
    await expect(levels).toBeHidden();
    await expect(bet).toHaveText('2,00');
  });
  const menu = page.getByTestId('menu');
  const menuButton = page.getByRole('button', { name: 'Меню' });
  await press(page, menuButton, () => expect(menu).toBeVisible());
  blocked.push(...(await targets(page, '[data-testid="menu"] button', true, orientation, 5)));
  // Меню не накрывает свою ☰ (прогон №7): второе касание по ней меню закрывает, а не жмёт пункт под пальцем.
  const seen = await menuButton.evaluate((button) => {
    const box = button.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === button;
  });
  expect(seen, 'середина ☰ при открытом меню — сама ☰').toBe(true);
  await press(page, menuButton, () => expect(menu).toBeHidden());
  await expect(page.locator('dialog'), 'второе касание ☰ не открыло диалог').toHaveCount(0);
  await press(page, menuButton, () => expect(menu).toBeVisible());
  await tapScene(page);
  await expect(menu).toBeHidden();
  expect(await rings(page)).toStrictEqual([]);
  await press(page, menuButton, () => expect(menu).toBeVisible());
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  // Автоигра: popover, флажок, «Почати»; полоса серии — «Стоп», потом «Сховати».
  const autoplay = page.getByTestId('autoplay');
  await press(page, page.getByRole('button', { name: 'Авто' }), () => expect(autoplay).toBeVisible());
  blocked.push(...(await targets(page, `[data-testid="autoplay"] ${CONTROLS}`, true, orientation, 8)));
  const count = autoplay.getByRole('button', { name: '25', exact: true });
  await press(page, count, () => expect(count).toHaveAttribute('aria-pressed', 'true'));
  const stopOnWin = autoplay.locator('label.choice').nth(1);
  await press(page, stopOnWin, () => expect(stopOnWin.locator('input')).toBeChecked());
  await press(page, stopOnWin, () => expect(stopOnWin.locator('input')).not.toBeChecked());
  const bar = page.getByTestId('autoplay-bar');
  await press(page, autoplay.getByRole('button', { name: 'Почати' }), () => expect(bar).toBeVisible());
  blocked.push(...(await targets(page, '.notices :is(button, a[href])', false, orientation, 1)));
  await press(page, bar.getByRole('button', { name: 'Стоп' }), () => expect(bar.getByRole('button', { name: 'Сховати' })).toBeVisible());
  await press(page, bar.getByRole('button', { name: 'Сховати' }), () => expect(bar).toBeHidden());
  await settle(page);
  const spin = page.getByRole('button', { name: 'Спін', exact: true });
  // Во время показа ставка и её кнопки выключены (и полупрозрачны), «Спін» — пропуск: выключенные области не держат, и
  // видимая «Спін» — своя. Замер засчитан, если и после него показ идёт; кончился раньше — следующий раунд.
  let during: TargetCheck | null = null;
  for (let attempt = 0; attempt < 3 && during === null; attempt++) {
    await press(page, spin, () => expect(spin).toHaveAttribute('aria-busy', 'true'));
    await expect(spin).toBeEnabled();
    const measured = await checkTargets(page, '.zone button', false, BLOCKED[orientation]);
    if ((await spin.getAttribute('aria-busy')) === 'true' && (await bet.isDisabled())) during = measured;
    await settle(page);
  }
  if (during === null) throw new Error('три раунда подряд показ кончился раньше замера');
  expect(during.count, '☰, ♪, «Спін» и «Турбо»').toBe(4);
  expect(during.problems, 'во время показа').toStrictEqual([]);
  // Диалоги: каждая кнопка, флажок и радио — касанием; закрытие — «×», фокус — на меню, рамки нет.
  const rules = await openDialog(page, 'Правила і виплати', orientation, 1);
  await closeDialog(page, rules);
  const settings = await openDialog(page, 'Налаштування', orientation, 6);
  const standard = settings.locator('label.choice', { hasText: 'Звичайні' });
  await press(page, standard, () => expect(standard.locator('input')).toBeChecked());
  const soundOn = settings.locator('label.choice', { hasText: 'Увімкнено' });
  await press(page, soundOn, () => expect(soundOn.locator('input')).not.toBeChecked());
  await press(page, soundOn, () => expect(soundOn.locator('input')).toBeChecked());
  await closeDialog(page, settings);
  const fairness = await openDialog(page, 'Чесність', orientation, 6, (dialog) => expect(dialog.getByTestId('commitment')).toBeVisible());
  await press(page, fairness.getByRole('button', { name: 'Новий секрет' }), () => expect(fairness.getByTestId('revealed')).toBeVisible());
  await press(page, fairness.getByRole('button', { name: 'Змінити сід' }), () => expect(fairness.getByTestId('revealed')).toBeVisible());
  await press(page, fairness.getByRole('button', { name: 'Перевірити раунд' }), () => expect(fairness.getByTestId('verify-result')).toBeVisible());
  await closeDialog(page, fairness);
  // Два раунда под новым секретом: в их строках истории только «Відтворити», строки рядом — шаг между ссылками тоже 44.
  for (let round = 0; round < 2; round++) {
    await press(page, spin, () => expect(spin).toHaveAttribute('aria-busy', 'true'));
    await settle(page);
  }
  // История: у раунда под прежним секретом есть «Перевірити»; «Відтворити» уводит на повтор, оттуда «Грати» — обратно.
  const history = await openDialog(page, 'Історія', orientation, 6, async (dialog) => {
    await expect(dialog.getByRole('button', { name: 'Перевірити' }).first()).toBeVisible();
    await expect(dialog.getByText('секрет ще не розкрито')).toHaveCount(2);
  });
  const check = history.getByRole('button', { name: 'Перевірити' }).first();
  await press(page, check, () => expect(history.getByText(/^(Збігається|Не збігається)$/).first()).toBeVisible());
  await press(page, history.getByRole('link', { name: 'Відтворити' }).first(), () => expect(page.locator('[data-notice="replay"]')).toBeVisible());
  // Повтор — новая страница: полоса в DOM раньше, чем пришли стили и шрифты (живой адрес, WebKit — раскладка без стилей:
  // ссылка у левого края), а мерить — то, что видно: после load и шрифтов.
  await page.waitForLoadState('load');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  blocked.push(...(await targets(page, '.notices :is(button, a[href])', false, orientation, 1)));
  await press(page, page.getByRole('link', { name: 'Грати' }), async () => {
    await expect(page.locator('[data-notice="replay"]')).toHaveCount(0);
    await idle(page);
  });
  // Лаборатория — последней: разовые действия ждут следующего запроса, раундов после неё нет.
  const lab = await openDialog(page, 'Лабораторія мережі', orientation, 10);
  const status = lab.getByTestId('lab-status');
  for (const [action, done] of [
    ['Загубити наступну відповідь', 'Наступна відповідь сервера загубиться'],
    ['Затримати наступне завершення раунду', 'Наступне завершення раунду чекатиме'],
    ['Відпустити затримане', 'Затримане відпущено'],
    ['Перезавантажити посеред наступного раунду', 'Сторінка перезавантажиться'],
    ['Чиста мережа', 'Мережа знову чиста'],
  ] as const) {
    await press(page, lab.getByRole('button', { name: action }), () => expect(status).toContainText(done));
  }
  await closeDialog(page, lab);
  return blocked;
}

for (const [platform, names] of [
  ['Android', ANDROID],
  ['iOS', IOS],
] as const) {
  for (const name of names) {
    for (const orientation of ORIENTATIONS) {
      test.describe(`${platform} · ${name} · ${orientation}`, () => {
        test.use(emulate(name, orientation));

        test('касание: подсветка браузера прозрачна, рамки после касания нет, область нажатия — квадрат 44 × 44', async ({ page }) => {
          test.setTimeout(240_000);
          await page.goto('./');
          await idle(page);
          const highlight = await tapHighlights(page);
          expect(highlight.scanned).toBeGreaterThan(20);
          expect(highlight.colored).toStrictEqual([]);
          const care = await hygiene(page);
          expect(care.buttons).toBeGreaterThan(8);
          expect({ appearance: care.appearance, touchAction: care.touchAction, selectable: care.selectable }).toStrictEqual({ appearance: [], touchAction: [], selectable: [] });
          // Меню iOS по долгому нажатию — свойство только iOS: CSSOM настольных движков его отбрасывает, поэтому — в отданном CSS.
          expect(await shippedCss(page)).toMatch(/\.scene\{[^}]*-webkit-touch-callout:\s*none/);
          const blocked = await touchTour(page, orientation);
          console.log(`${platform} · ${name} · ${orientation}: заслонены — ${blocked.join(', ') || 'нет'}`);
          // Положительные контроли тех же проверок на этой странице: каждая ловит то, что ловить должна.
          await page.addStyleTag({ content: '* { -webkit-tap-highlight-color: rgba(255, 0, 0, 1) !important; }' });
          expect((await tapHighlights(page)).colored.length).toBeGreaterThan(20);
          await page.addStyleTag({ content: "* { -webkit-tap-highlight-color: transparent !important; } .panel .refill::before { content: none !important; } :root[data-input] :focus-visible { outline: 3px solid red !important; }" });
          // «Поповнити» ниже 44 px на всех восьми устройствах: без своей области квадрата у неё нет.
          const lost = await checkTargets(page, '.zone button', false, BLOCKED[orientation]);
          expect(lost.problems.filter((problem) => problem.startsWith('Поповнити'))).toHaveLength(1);
          const lab = page.getByRole('dialog', { name: 'Лабораторія мережі' });
          await tap(page, page.getByRole('button', { name: 'Меню' }));
          await tap(page, page.getByTestId('menu').getByRole('button', { name: 'Лабораторія мережі' }));
          await expect(lab).toBeVisible();
          // Диалог, открытый касанием, поле не фокусирует — фокус в поле даёт касание по нему.
          const field = lab.getByLabel('Затримка, мс');
          await tap(page, field);
          await expect(field).toBeFocused();
          expect(await rings(page), 'рамка на поле «Лабораторії» после касания — без правила последнего ввода').not.toStrictEqual([]);
        });

        test('клавиатура: после Tab рамка у каждой кнопки панели, popover и диалогов — сплошная, не тоньше 2 px, по форме кнопки', async ({ page, browserName }) => {
          test.setTimeout(240_000);
          await page.goto('./');
          await idle(page);
          // Раунд — пробелом: в истории будет строка с «Відтворити», после нового секрета — и с «Перевірити».
          await page.keyboard.press('Space');
          await expect(page.getByRole('button', { name: 'Спін', exact: true })).toHaveAttribute('aria-busy', 'true');
          await settle(page);
          await page.addStyleTag({ content: '.scene-canvas { visibility: hidden !important; }' });
          // Без GPU (CI) полоса эконом-режима 8 с лежит над верхней зоной: рамку ☰ и ♪ под ней не видно — ждём, пока уйдёт.
          await expect(page.locator('[data-notice="economy"]')).toHaveCount(0, { timeout: 20_000 });
          // WebKit на macOS по Tab кнопки не обходит (настройка системы) — там Option+Tab; на Linux — Tab.
          const next = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
          const problems: string[] = [];
          const checked: string[] = [];
          /** Tab, пока фокус не вернётся к уже проверенному; рамка — у каждого нового элемента управления. */
          const walk = async (limit: number): Promise<number> => {
            let fresh = 0;
            for (let step = 0; step < limit; step++) {
              const repeat = await page.evaluate(() => {
                const element = document.activeElement;
                if (element === null || element === document.body || !element.matches('button, a[href], input, select, textarea')) return 'skip';
                if (element.hasAttribute('data-ring-checked')) return 'repeat';
                element.setAttribute('data-ring-checked', '');
                return 'new';
              });
              if (repeat === 'repeat') break;
              if (repeat === 'new') {
                const ring = await focusRing(page);
                if (ring === null) throw new Error('фокус ушёл до снимка');
                fresh++;
                checked.push(ring.name);
                const { stray, band, covered, strayAt } = ring.report;
                if (ring.style !== 'solid' || ring.width < 2 || stray > 0 || band === 0 || covered / band < 0.9) {
                  problems.push(`${ring.name}: ${ring.style} ${String(ring.width)}px, лишних ${String(stray)} ${strayAt.join(' ')}, полоса ${String(covered)}/${String(band)}`);
                }
                // Радио и флажок рисует система, скругление у них браузер сбрасывает: своя рамка была бы квадратом вокруг
                // круга — рамка у строки выбора, у самого поля её нет.
                if ((ring.type === 'radio' || ring.type === 'checkbox') && (!ring.name.startsWith('LABEL:') || ring.inner !== 'none')) {
                  problems.push(`${ring.name}: ${ring.type} — рамка не у строки выбора (у поля — ${ring.inner})`);
                }
              }
              await page.keyboard.press(next);
            }
            return fresh;
          };
          /** Tab до элемента с этим доступным именем. */
          const focusOn = async (target: Locator): Promise<void> => {
            for (let step = 0; step < 40; step++) {
              if (await target.evaluate((element) => element === document.activeElement)) return;
              await page.keyboard.press(next);
            }
            throw new Error('Tab не дошёл до элемента');
          };
          await page.keyboard.press(next);
          expect(await walk(30), 'панель').toBeGreaterThanOrEqual(9);
          const menuButton = page.getByRole('button', { name: 'Меню' });
          await focusOn(menuButton);
          await page.keyboard.press('Enter');
          await expect(page.getByTestId('menu')).toBeVisible();
          await page.keyboard.press(next);
          expect(await walk(12), 'меню').toBeGreaterThanOrEqual(5);
          await page.keyboard.press('Escape');
          await focusOn(page.getByTestId('bet'));
          await page.keyboard.press('Enter');
          await expect(page.getByTestId('bet-levels')).toBeVisible();
          await page.keyboard.press(next);
          expect(await walk(14), 'ставка').toBeGreaterThanOrEqual(9);
          await page.keyboard.press('Escape');
          await focusOn(page.getByRole('button', { name: 'Авто' }));
          await page.keyboard.press('Enter');
          await expect(page.getByTestId('autoplay')).toBeVisible();
          await page.keyboard.press(next);
          expect(await walk(14), 'автоигра').toBeGreaterThanOrEqual(6);
          await page.keyboard.press('Escape');
          for (const [item, least] of [
            ['Правила і виплати', 1],
            ['Налаштування', 4],
            ['Чесність', 8],
            ['Лабораторія мережі', 10],
            ['Історія', 3],
          ] as const) {
            await focusOn(menuButton);
            await page.keyboard.press('Enter');
            await focusOn(page.getByTestId('menu').getByRole('button', { name: item }));
            await page.keyboard.press('Enter');
            const dialog = page.getByRole('dialog', { name: item });
            await expect(dialog).toBeVisible();
            const first = KEYBOARD_FIRST[item];
            if (first === undefined) throw new Error(`нет первого фокуса для «${item}»`);
            await expect(first(dialog), `${item}: первый фокус с клавиатуры`).toBeFocused();
            if (item === 'Історія') await expect(dialog.getByRole('button', { name: 'Перевірити' })).toBeVisible();
            if (item === 'Чесність') await expect(dialog.getByTestId('commitment')).toBeVisible();
            expect(await walk(24), item).toBeGreaterThanOrEqual(least);
            if (item === 'Чесність') {
              // Новый секрет раскрывает прежний: у раунда в истории появится «Перевірити».
              await focusOn(dialog.getByRole('button', { name: 'Новий секрет' }));
              await page.keyboard.press('Enter');
              await expect(dialog.getByTestId('revealed')).toBeVisible();
            }
            await page.keyboard.press('Escape');
            await expect(page.locator('dialog')).toHaveCount(0);
          }
          console.log(`${platform} · ${name} · ${orientation}: рамок проверено ${String(checked.length)}`);
          expect(checked.length).toBeGreaterThan(40);
          expect(problems).toStrictEqual([]);
          // Положительный контроль формы: прямоугольная рамка вокруг зоны «Спін» вместо круглой у самой кнопки — та же
          // ошибка «круг внутри прямоугольника». Она тоже только с клавиатуры: снимок без рамки снимает её отметкой ввода.
          const spin = page.getByRole('button', { name: 'Спін', exact: true });
          await focusOn(spin);
          await page.addStyleTag({
            content: ".spin:focus-visible { outline: none !important; } :root:not([data-input='pointer']) .zone-spin:has(> .spin:focus-visible) { outline: 3px solid #3fe0d0; outline-offset: 2px; }",
          });
          const square = await focusRing(page);
          expect(square?.report.stray ?? 0, 'прямоугольная рамка вокруг круга').toBeGreaterThan(20);
        });
      });
    }
  }
}

/**
 * Нажатая «Спін» приходит к своему виду, пока её держит мышь: :active тот же, что от пальца, а мышь держит его до
 * отпускания (синтетическое касание на Linux в CI :active не даёт — CI 38156248243, 38168834155). Переход в headless идёт
 * медленнее 80 мс — ждём итоговый вид; не придёт, если нажатое другое. Отпускание — мимо кнопки: клика нет.
 */
async function pressedTo(page: Page, spin: Locator, look: { readonly filter: string; readonly transform: string }): Promise<void> {
  const box = await spin.boundingBox();
  if (box === null) throw new Error('нет «Спін»');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect
    .poll(() => spin.evaluate((element) => ({ active: element.matches(':active'), filter: getComputedStyle(element).filter, transform: getComputedStyle(element).transform })), { timeout: 3000 })
    .toStrictEqual({ active: true, ...look });
  await page.mouse.move(box.x + box.width / 2, 2);
  await page.mouse.up();
}

for (const [platform, name] of [
  ['Android', 'Galaxy S5'],
  ['iOS', 'iPhone SE (3rd gen)'],
] as const) {
  test.describe(`${platform} · ${name} · нажатие`, () => {
    test.use(emulate(name, 'портрет'));

    test('нажатое «Спін» — темнее и меньше, при reduced motion — без масштаба; выделение выключено', async ({ page }) => {
      await page.goto('./');
      await idle(page);
      const spin = page.getByRole('button', { name: 'Спін', exact: true });
      await pressedTo(page, spin, { filter: 'brightness(0.8)', transform: 'matrix(0.95, 0, 0, 0.95, 0, 0)' });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await pressedTo(page, spin, { filter: 'brightness(0.8)', transform: 'none' });
      await expect(spin, 'отпускание мимо — клика нет').toHaveAttribute('aria-busy', 'false');
      // Долгое касание по-настоящему — tests/gpu/long-press.spec.ts (локально): в CI синтетическое касание не доходит.
      expect(await spin.evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-user-select'))).toBe('none');
    });
  });
}
