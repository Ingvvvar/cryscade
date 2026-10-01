import { expect, test } from '../support/fixtures.ts';
import { waitForState } from '../support/game-page.ts';
import { consoleProblem } from '../support/page-probe.ts';

// Положительный контроль общей фикстуры консоли (§14, фаза 9): предупреждение и ошибка страницы попадают в
// consoleWatch.problems; тест, который их не убрал, фикстура роняет в конце — второй тест помечен ожидаемым провалом
// (test.fail): пройди он, Playwright счёл бы это ошибкой. Шаблоны среды — только целиком.

test('фикстура консоли видит предупреждение и ошибку страницы; сообщения среды — не провал, только целиком', async ({ page, consoleWatch }) => {
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  expect(consoleWatch.problems).toStrictEqual([]);
  await page.evaluate(() => {
    console.warn('контроль консоли');
    window.setTimeout(() => {
      throw new Error('контроль ошибки');
    }, 0);
  });
  await expect.poll(() => consoleWatch.problems.length).toBe(2);
  expect(consoleWatch.problems).toStrictEqual(['warning: контроль консоли', 'pageerror: контроль ошибки']);
  consoleWatch.problems.length = 0;
  expect(consoleProblem('warning', 'No available adapters.')).toBeNull();
  expect(consoleProblem('warning', 'No available adapters. Retry')).toBe('warning: No available adapters. Retry');
  expect(consoleProblem('error', 'No available adapters.')).toBe('error: No available adapters.');
});

test('фикстура консоли видит и контекст, который тест создал сам (browser.newContext)', async ({ browser, consoleWatch }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await page.evaluate(() => {
    console.error('контроль: свой контекст');
  });
  await expect.poll(() => consoleWatch.problems).toStrictEqual(['error: контроль: свой контекст']);
  consoleWatch.problems.length = 0;
  await context.close();
});

test('фикстура консоли роняет тест, который оставил предупреждение', async ({ page }) => {
  test.fail(true, 'положительный контроль: консоль не пуста — фикстура обязана уронить тест');
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await page.evaluate(() => {
    console.warn('контроль: не убрано');
  });
  await page.waitForTimeout(200);
});
