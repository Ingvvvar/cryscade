import { expect, test } from '@playwright/test';
import { waitForState } from '../support/game-page.ts';
import { collectConsole } from '../support/page-probe.ts';

// Клавиатура (§11, решение 7 фазы 7) — только Chromium: WebKit на macOS по Tab кнопки не обходит (настройка системы
// «полный доступ с клавиатуры»), это не свойство игры. Видимый фокус — рамка у каждой кнопки, до которой дошёл Tab.

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
