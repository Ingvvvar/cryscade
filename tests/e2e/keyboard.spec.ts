import { type Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { dialogClosed, readStorage, waitForState } from '../support/game-page.ts';
import { collectConsole, type ProbeWindow } from '../support/page-probe.ts';

// Клавиатура (§11, решения 7, 9 и 10 фазы 7) — только Chromium: WebKit на macOS по Tab кнопки не обходит (настройка
// системы «полный доступ с клавиатуры»), это не свойство игры. Видимый фокус — рамка у каждой кнопки, до которой дошёл
// Tab; строгий пресет — вся игра без мыши; каждый диалог — открыть, фокус внутри, Esc. Рендеры App за раунд — в
// renders.spec (Tab там не нужен, он идёт и в WebKit).

interface Focused {
  readonly tag: string;
  readonly name: string;
  readonly outline: string;
  readonly width: number;
}

test('видимый фокус: Tab по панели — у каждой кнопки рамка фокуса', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  const seen: Focused[] = [];
  for (let step = 0; step < 12; step++) {
    await page.keyboard.press('Tab');
    seen.push(
      await page.evaluate(() => {
        const element = document.activeElement;
        if (!(element instanceof HTMLElement)) return { tag: 'none', name: '', outline: 'none', width: 0 };
        const style = getComputedStyle(element);
        return { tag: element.tagName, name: element.getAttribute('aria-label') ?? element.textContent, outline: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
      }),
    );
  }
  const buttons = seen.filter((item) => item.tag === 'BUTTON');
  expect(new Set(buttons.map((item) => item.name)).size).toBeGreaterThan(6);
  expect(buttons.filter((item) => item.outline === 'none' || !(item.width > 0))).toStrictEqual([]);
  expect(problems).toEqual([]);
});

/** Фокус — на элементе с этим доступным именем; Tab, пока не дойдёт (не больше limit шагов). */
async function tabTo(page: Page, name: string, limit = 30): Promise<void> {
  for (let step = 0; step < limit; step++) {
    const current = await page.evaluate(() => {
      const element = document.activeElement;
      return element instanceof HTMLElement ? (element.getAttribute('aria-label') ?? element.textContent).trim() : '';
    });
    if (current === name) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab не дошёл до «${name}»`);
}

/** Следующий раунд — проигрыш (зонд e2e-сборки): случайная фича ждала бы тапа, а клавиатурный тест — не про раунд. */
async function forceLoss(page: Page): Promise<void> {
  await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.force('loss'));
}

async function closedRounds(page: Page): Promise<number> {
  return (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length;
}

test('строгий пресет только с клавиатуры: пробел — спин, + — ставка, меню и настройки — Tab, Enter, стрелки, Esc', async ({ page }) => {
  test.setTimeout(90_000);
  const { problems } = collectConsole(page);
  await page.goto('./?jurisdiction=strict');
  await waitForState(page, 'idle');
  await expect(page.locator('.session-top')).toBeVisible();
  await forceLoss(page);
  await page.keyboard.press('Space');
  await expect.poll(() => closedRounds(page), { timeout: 30_000 }).toBe(1);
  await waitForState(page, 'idle');
  await page.keyboard.press('+');
  await expect(page.getByTestId('bet')).toHaveText('2,00');
  await forceLoss(page);
  await page.keyboard.press('Space');
  await expect.poll(() => closedRounds(page), { timeout: 30_000 }).toBe(2);
  await waitForState(page, 'idle');
  expect((await readStorage(page)).rounds.map((round) => round.betMinor).sort()).toStrictEqual([100, 200]);
  await tabTo(page, 'Меню');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('menu')).toBeVisible();
  await tabTo(page, 'Налаштування');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Налаштування' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Українська' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: 'English' })).toBeChecked();
  await page.keyboard.press('Escape');
  await dialogClosed(page);
  await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
  await expect(page.locator('.session-top [data-testid="session-net"]')).toBeVisible();
  expect(problems).toEqual([]);
});

test('каждый диалог с клавиатуры: Enter открывает, фокус внутри, Esc закрывает, фокус — на кнопке меню', async ({ page }) => {
  test.setTimeout(60_000);
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  for (const item of ['Правила і виплати', 'Налаштування', 'Історія', 'Чесність', 'Лабораторія мережі']) {
    await tabTo(page, 'Меню');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('menu')).toBeVisible();
    await tabTo(page, item);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: item });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement)), { message: `${item}: фокус внутри` }).toBe(true);
    await page.keyboard.press('Escape');
    await dialogClosed(page);
    await expect(page.getByRole('button', { name: 'Меню' })).toBeFocused();
  }
  expect(problems).toEqual([]);
});
