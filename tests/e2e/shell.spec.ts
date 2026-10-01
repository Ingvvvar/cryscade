import { type Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import type { ShownRound } from '../../src/client/index.ts';
import type { SceneLabels } from '../../src/render/renderer.ts';
import { FORCED_SEEDS } from '../../src/ui/forced-rounds.ts';
import { MoneyFormat } from '../../src/ui/money-format.ts';
import { gameSnapshot, readStorage, waitForState, type StoredState } from '../support/game-page.ts';
import { decodePng } from '../support/png.ts';
import { collectConsole, type ProbeWindow } from '../support/page-probe.ts';
import { fixtureShown, seedShown } from '../support/shown-rounds.ts';

// Оболочка фазы 7 (§11): настройки — язык сразу, правила гри (пресет) — со следующего раунда, ?jurisdiction= сильнее
// настройки; сессия вкладки — в строгом пресете на экране, в обычном — в меню; переживает перезагрузку, у новой вкладки
// своя. Диалог — нативный <dialog>: Esc закрывает, фокус возвращается на кнопку меню.

/** Чистый результат закрытых раундов — по записям IndexedDB, своим путём: «+12,50», «−3,00», «0,00». */
function expectedNet(state: StoredState, locale: string): string {
  const net = state.rounds.filter((round) => round.status === 'closed').reduce((sum, round) => sum + round.winMinor - round.betMinor, 0);
  const money = new MoneyFormat(locale);
  return net === 0 ? money.format(0) : `${net > 0 ? '+' : '−'}${money.format(Math.abs(net))}`;
}

async function openSettings(page: Page, menu: string, settings: string): Promise<void> {
  await page.getByRole('button', { name: menu }).click();
  await page.getByRole('button', { name: settings }).click();
  await expect(page.getByRole('dialog', { name: settings })).toBeVisible();
}

/** Кадр показа стоит на доле share сегмента segment группы group раунда round; тикер остановлен, кадр отрисован. */
async function hold(page: Page, round: ShownRound, segment: string, group: string, share: number): Promise<SceneLabels | null> {
  return page.evaluate(
    ({ shown, kind, groupKind, at }) => {
      const probe = (window as ProbeWindow).__cryscadeProbe;
      if (probe === undefined) throw new Error('нет зонда');
      probe.stopTicker();
      probe.still(shown, 0);
      const schedule = probe.schedule();
      const target = schedule?.segments.find((item) => item.kind === kind && schedule.groups[item.group]?.kind === groupKind);
      if (target === undefined) throw new Error(`нет сегмента ${kind}`);
      probe.still(shown, Math.floor(target.startMs + (target.endMs - target.startMs) * at));
      probe.renderOnce();
      return probe.sceneLabels();
    },
    { shown: round, kind: segment, groupKind: group, at: share },
  );
}

/** Тот же кадр ещё раз — после смены языка. */
async function redraw(page: Page): Promise<SceneLabels | null> {
  return page.evaluate(() => {
    const probe = (window as ProbeWindow).__cryscadeProbe;
    probe?.renderOnce();
    return probe?.sceneLabels() ?? null;
  });
}

async function spinOnce(page: Page, closed: number): Promise<void> {
  await page.keyboard.press('Space');
  await expect.poll(async () => (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length, { timeout: 15_000 }).toBe(closed);
  await waitForState(page, 'idle');
}

test('настройки: английский — панель, суммы и надписи сцены сразу, и на кадре, что уже стоит; Esc закрывает, фокус — на меню; выбор переживает перезагрузку', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  const retrigger = fixtureShown('retrigger');
  const bigWin = seedShown(FORCED_SEEDS.bigWin1);
  const intro = await hold(page, fixtureShown('feature-start'), 'plaqueIn', 'feature', 1);
  expect([intro?.plaque, intro?.hint]).toStrictEqual(['Фріспіни', 'Натисніть, щоб продовжити']);
  const uk = await hold(page, retrigger, 'plaqueIn', 'retrigger', 1);
  expect([uk?.freeSpins, uk?.plaque, uk?.counter.includes(',')]).toStrictEqual(['Фріспіни', '+5 фріспінів', true]);
  const celebration = await hold(page, bigWin, 'celebrate', 'bigWin', 0.5);
  expect(celebration?.bigWin).toBe('Великий виграш');
  const ukCounter = celebration?.counter ?? '';
  expect(ukCounter).toMatch(/^\d+,\d\d$/);
  await openSettings(page, 'Меню', 'Налаштування');
  await expect(page.getByRole('radio', { name: 'Українська' })).toBeFocused();
  await page.getByRole('radio', { name: 'English' }).check();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Spin' })).toBeVisible();
  await expect(page.getByTestId('balance')).toHaveText('1,000.00');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
  // Кадр большого выигрыша стоит с украинского: после смены языка — английская надпись и точка в той же сумме.
  const same = await redraw(page);
  expect([same?.bigWin, same?.counter]).toStrictEqual(['Big win', ukCounter.replace(',', '.')]);
  // Плашка ретриггера та же, что была по-украински: надпись — заново, по-английски.
  const en = await hold(page, retrigger, 'plaqueIn', 'retrigger', 1);
  expect([en?.freeSpins, en?.plaque, en?.counter.includes('.')]).toStrictEqual(['Free spins', '+5 free spins', true]);
  const introEn = await hold(page, fixtureShown('feature-start'), 'plaqueIn', 'feature', 1);
  expect([introEn?.plaque, introEn?.hint]).toStrictEqual(['Free spins', 'Tap to continue']);
  await page.reload();
  await waitForState(page, 'idle');
  await expect(page.getByRole('button', { name: 'Spin' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cryscade:settings'))).toBe('{"v":1,"language":"en","preset":"standard","sound":true}');
  expect(problems).toEqual([]);
});

test('правила гри: строгі — турбо выключено и сессия на экране сразу, цикл спина от 2500 мс; переживают перезагрузку; ?jurisdiction=standard сильнее настройки', async ({ page }) => {
  test.setTimeout(60_000);
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await expect(page.locator('.session-top')).toHaveCount(0);
  await openSettings(page, 'Меню', 'Налаштування');
  await expect(page.getByText('Діють з наступного раунду')).toBeVisible();
  await page.getByRole('radio', { name: 'Строгі (модель UKGC)' }).check();
  await page.keyboard.press('Escape');
  await expect(page.locator('.session-top')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cryscade' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Турбо' })).toBeDisabled();
  // Фокус вернулся на кнопку меню — пробел нажал бы её; спин — кнопкой.
  await page.getByRole('button', { name: 'Спін' }).click();
  await expect.poll(async () => (await gameSnapshot(page)).state.name).toBe('presenting');
  const duration = await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.schedule()?.durationMs ?? 0);
  expect(duration).toBeGreaterThanOrEqual(2500);
  await expect.poll(async () => (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length, { timeout: 30_000 }).toBe(1);
  await waitForState(page, 'idle');
  const net = expectedNet(await readStorage(page), 'uk-UA');
  await expect(page.locator('.session-top [data-testid="session-net"]')).toHaveText(net);
  const time = page.locator('.session-top [data-testid="session-time"]');
  await expect(time).toHaveText(/^00:\d\d$/);
  // Время идёт само, раз в секунду.
  const shown = await time.textContent();
  await expect(time).not.toHaveText(shown ?? '', { timeout: 3000 });
  await page.reload();
  await waitForState(page, 'idle');
  await expect(page.locator('.session-top [data-testid="session-net"]')).toHaveText(net);
  await page.goto('./?autoskip=1&jurisdiction=standard');
  await waitForState(page, 'idle');
  await expect(page.locator('.session-top')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Турбо' })).toBeEnabled();
  await openSettings(page, 'Меню', 'Налаштування');
  await expect(page.getByRole('radio', { name: 'Звичайні' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Строгі (модель UKGC)' })).toBeDisabled();
  await expect(page.getByText('Задано посиланням — налаштування їх не змінює')).toBeVisible();
  expect(problems).toEqual([]);
});

test('сессия в обычном пресете — в меню: результат закрытых раундов этой вкладки; переживает перезагрузку, у новой вкладки — своя', async ({ page, context }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await spinOnce(page, 1);
  await spinOnce(page, 2);
  const net = expectedNet(await readStorage(page), 'uk-UA');
  await page.getByRole('button', { name: 'Меню' }).click();
  const menuNet = page.getByTestId('menu').getByTestId('session-net');
  await expect(menuNet).toHaveText(net);
  await page.reload();
  await waitForState(page, 'idle');
  await page.getByRole('button', { name: 'Меню' }).click();
  await expect(menuNet).toHaveText(net);
  const fresh = await context.newPage();
  await fresh.goto('./?autoskip=1');
  await waitForState(fresh, 'idle');
  await fresh.getByRole('button', { name: 'Меню' }).click();
  await expect(fresh.getByTestId('menu').getByTestId('session-net')).toHaveText('0,00');
  expect(problems).toEqual([]);
});

/** Относительная яркость WCAG 2.x пикселя sRGB. */
function luminance(r: number, g: number, b: number): number {
  const channel = (value: number): number => (value / 255 <= 0.03928 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

test('контраст AA: «Спін» на своём градиенте — самый светлый фон под надписью не меньше 4.5:1 к тексту; портрет и ландшафт', async ({ browser }) => {
  // Надпись прозрачная, канвас скрыт: под рамкой надписи остаётся только градиент кнопки на фоне страницы.
  const text = luminance(0xee, 0xf3, 0xff);
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto('./?autoskip=1');
    await waitForState(page, 'idle');
    await page.addStyleTag({ content: '.scene-canvas { visibility: hidden !important; } .spin { color: transparent !important; }' });
    const box = await page.getByRole('button', { name: 'Спін' }).evaluate((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    expect(box.width * box.height, 'рамка надписи').toBeGreaterThan(100);
    const image = decodePng(await page.screenshot({ clip: box }));
    let brightest = 0;
    for (let at = 0; at < image.rgba.length; at += 4) brightest = Math.max(brightest, luminance(image.rgba[at] ?? 0, image.rgba[at + 1] ?? 0, image.rgba[at + 2] ?? 0));
    const ratio = (text + 0.05) / (brightest + 0.05);
    console.log(`«Спін», ${String(viewport.width)}×${String(viewport.height)}: самый светлый фон L = ${brightest.toFixed(3)}, контраст ${ratio.toFixed(2)}`);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    await context.close();
  }
});

test('«Турбо»: aria-pressed и видимое нажатое — фон и цвет текста другие; контраст надписи на заливке — не меньше 4.5:1 по пикселям', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  const turbo = page.getByRole('button', { name: 'Турбо' });
  const look = (): Promise<{ background: string; color: string }> =>
    turbo.evaluate((button) => {
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, color: style.color };
    });
  await expect(turbo).toHaveAttribute('aria-pressed', 'false');
  const off = await look();
  await turbo.click();
  await expect(turbo).toHaveAttribute('aria-pressed', 'true');
  const on = await look();
  expect(on.background, 'заливка нажатой').not.toBe(off.background);
  expect(on.color, 'цвет надписи нажатой').not.toBe(off.color);
  // Надпись прозрачная: под её рамкой остаётся только заливка кнопки. Текст тёмный — худший фон самый тёмный пиксель.
  const text = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(on.color);
  if (text === null) throw new Error(`цвет надписи: ${on.color}`);
  await page.addStyleTag({ content: '.toggle { color: transparent !important; }' });
  const box = await turbo.evaluate((button) => {
    const range = document.createRange();
    range.selectNodeContents(button);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  expect(box.width * box.height, 'рамка надписи').toBeGreaterThan(100);
  const image = decodePng(await page.screenshot({ clip: box }));
  let darkest = 1;
  for (let at = 0; at < image.rgba.length; at += 4) darkest = Math.min(darkest, luminance(image.rgba[at] ?? 0, image.rgba[at + 1] ?? 0, image.rgba[at + 2] ?? 0));
  const ratio = (darkest + 0.05) / (luminance(Number(text[1]), Number(text[2]), Number(text[3])) + 0.05);
  console.log(`«Турбо» нажато: самый тёмный фон L = ${darkest.toFixed(3)}, контраст ${ratio.toFixed(2)}`);
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  await turbo.click();
  await expect(turbo).toHaveAttribute('aria-pressed', 'false');
  expect((await look()).background, 'отжатая — прежняя заливка').toBe(off.background);
  expect(problems).toEqual([]);
});

test('ставка с клавиатуры и из списка: + и − по уровням, в диалоге клавиши игры не действуют; popover — выбор, Esc, фокус на кнопку ставки; спин идёт с выбранной', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  const bet = page.getByTestId('bet');
  await expect(bet).toHaveText('1,00');
  await page.keyboard.press('+');
  await expect(bet).toHaveText('2,00');
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  await expect(bet).toHaveText('0,40');
  await page.keyboard.press('=');
  await expect(bet).toHaveText('1,00');
  // В диалоге и в popover клавиши игры не действуют — и с фокусом на кнопке, не только в поле ввода.
  await openSettings(page, 'Меню', 'Налаштування');
  await page.getByRole('button', { name: 'Закрити' }).focus();
  await page.keyboard.press('+');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(bet).toHaveText('1,00');
  await bet.click();
  const levels = page.getByTestId('bet-levels');
  await expect(levels).toBeVisible();
  await levels.getByRole('button', { name: '2,00', exact: true }).focus();
  await page.keyboard.press('-');
  await expect(bet).toHaveText('1,00');
  await expect(levels.getByRole('button')).toHaveText(['0,20', '0,40', '1,00', '2,00', '4,00', '10,00', '20,00', '50,00', '100,00']);
  await expect(levels.getByRole('button', { name: '1,00', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await levels.getByRole('button', { name: '10,00', exact: true }).click();
  await expect(levels).toBeHidden();
  await expect(bet).toHaveText('10,00');
  await expect(bet).toBeFocused();
  await bet.click();
  await expect(levels).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(levels).toBeHidden();
  await expect(bet).toHaveText('10,00');
  await page.getByRole('button', { name: 'Спін' }).click();
  await expect.poll(async () => (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length).toBe(1);
  expect((await readStorage(page)).rounds.map((round) => round.betMinor)).toStrictEqual([1000]);
  expect(problems).toEqual([]);
});

test('итог раунда — экранному диктору: одно объявление на раунд, когда раунд закрыт; текст — выигрыш и баланс', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await expect(page.getByTestId('announcer')).toHaveAttribute('aria-live', 'polite');
  await page.evaluate(() => {
    const node = document.querySelector('[data-testid="announcer"]');
    const log: string[] = [];
    (window as unknown as { announced: string[] }).announced = log;
    if (node === null) throw new Error('нет объявлений');
    new MutationObserver(() => {
      log.push(node.textContent);
    }).observe(node, { childList: true, characterData: true, subtree: true });
  });
  // Выигрыш и проигрыш — принудительными раундами (зонд, только e2e-сборка): оба вида текста.
  for (const [name, closed] of [
    ['smallWin', 1],
    ['loss', 2],
  ] as const) {
    await page.evaluate((round) => (window as ProbeWindow).__cryscadeProbe?.force(round), name);
    await spinOnce(page, closed);
  }
  const announced = await page.evaluate(() => (window as unknown as { announced: string[] }).announced);
  const money = new MoneyFormat('uk-UA');
  const rounds = [...(await readStorage(page)).rounds].sort((a, b) => a.seq - b.seq) as unknown as { winMinor: number; balanceAfterEnd: number }[];
  expect(rounds.map((round) => round.winMinor > 0)).toStrictEqual([true, false]);
  expect(announced).toStrictEqual(
    rounds.map((round) =>
      round.winMinor > 0
        ? `Виграш ${money.format(round.winMinor)}. Баланс ${money.format(round.balanceAfterEnd)}`
        : `Без виграшу. Баланс ${money.format(round.balanceAfterEnd)}`,
    ),
  );
  expect(problems).toEqual([]);
});

test('сессия в строгом пресете: узкая верхняя зона (телефон) — без подписей, широкая — с ними (container query)', async ({ browser }) => {
  for (const [viewport, labelled] of [
    [{ width: 390, height: 844 }, false],
    [{ width: 1440, height: 900 }, true],
  ] as const) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto('./?autoskip=1&jurisdiction=strict');
    await waitForState(page, 'idle');
    const labels = page.locator('.session-top .session-label');
    await expect(labels).toHaveCount(2);
    await expect(page.locator('.session-top [data-testid="session-net"]')).toBeVisible();
    expect([viewport.width, await labels.first().isVisible(), await labels.last().isVisible()]).toStrictEqual([viewport.width, labelled, labelled]);
    await context.close();
  }
});
