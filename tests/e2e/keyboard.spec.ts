import { expect, test, type Page } from '@playwright/test';
import type { ForcedName } from '../../src/ui/forced-rounds.ts';
import { readStorage, waitForState } from '../support/game-page.ts';
import { collectConsole, type ProbeWindow } from '../support/page-probe.ts';

// Клавиатура (§11, решения 7, 9 и 10 фазы 7) — только Chromium: WebKit на macOS по Tab кнопки не обходит (настройка
// системы «полный доступ с клавиатуры»), это не свойство игры. Видимый фокус — рамка у каждой кнопки, до которой дошёл
// Tab; строгий пресет — вся игра без мыши; каждый диалог — открыть, фокус внутри, Esc. Рендеры App за раунд без ввода —
// React Profiler (e2e-сборка — профилирующий react-dom).

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

async function closedRounds(page: Page): Promise<number> {
  return (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length;
}

test('строгий пресет только с клавиатуры: пробел — спин, + — ставка, меню и настройки — Tab, Enter, стрелки, Esc', async ({ page }) => {
  test.setTimeout(90_000);
  const { problems } = collectConsole(page);
  await page.goto('./?jurisdiction=strict');
  await waitForState(page, 'idle');
  await expect(page.locator('.session-top')).toBeVisible();
  await page.keyboard.press('Space');
  await expect.poll(() => closedRounds(page), { timeout: 30_000 }).toBe(1);
  await waitForState(page, 'idle');
  await page.keyboard.press('+');
  await expect(page.getByTestId('bet')).toHaveText('2,00');
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
  await expect(page.getByRole('dialog')).toHaveCount(0);
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
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Меню' })).toBeFocused();
  }
  expect(problems).toEqual([]);
});

test('рендеры App за раунд без ввода — не больше 10, худший из трёх раундов на обычной скорости; контроль — турбо даёт коммиты', async ({ page }) => {
  test.setTimeout(120_000);
  const { problems } = collectConsole(page);
  await page.goto('./');
  await waitForState(page, 'idle');
  const commits = (): Promise<number> => page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.appCommits() ?? -1);
  // Контроль: ввод — турбо включить и выключить — Profiler видит его коммиты; раунды идут на обычной скорости.
  const control = await commits();
  const turbo = page.getByRole('button', { name: 'Турбо' });
  await turbo.click();
  await expect(turbo).toHaveAttribute('aria-pressed', 'true');
  await turbo.click();
  await expect(turbo).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(commits, { message: 'Profiler видит коммиты от ввода' }).toBeGreaterThanOrEqual(control + 2);
  const counts: number[] = [];
  const rounds: readonly ForcedName[] = ['loss', 'cascade', 'multiplier'];
  for (const [index, round] of rounds.entries()) {
    await page.evaluate((name) => (window as ProbeWindow).__cryscadeProbe?.force(name), round);
    const before = await commits();
    // Ввод — один клик по «Спін»; дальше раунд идёт сам до покоя.
    await page.getByRole('button', { name: 'Спін' }).click();
    await expect.poll(() => closedRounds(page), { timeout: 60_000 }).toBe(index + 1);
    await waitForState(page, 'idle', 30_000);
    counts.push((await commits()) - before);
  }
  console.log(`рендеры App за раунд (проигрыш, каскад, множитель): ${counts.join(', ')}; худший ${String(Math.max(...counts))}`);
  expect(Math.min(...counts)).toBeGreaterThan(0);
  expect(Math.max(...counts)).toBeLessThanOrEqual(10);
  expect(problems).toEqual([]);
});
