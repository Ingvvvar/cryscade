// Общая фикстура e2e (§14, фаза 9): пустая консоль — в каждом тесте, а не отдельным. Авто-фикстура слушает консоль и
// ошибки всех страниц контекста теста и контекстов, которые тест создаёт сам (browser.newContext), и в конце теста
// требует пустой список. Не провал — только шум dev-сервера и сообщения среды без GPU (consoleProblem). Сообщение,
// которого тест ждёт нарочно, он сверяет сам и убирает из consoleWatch.problems.

import { test as base, type BrowserContext } from '@playwright/test';
import { consoleProblem } from './page-probe.ts';

export { expect } from '@playwright/test';

export interface ConsoleWatch {
  /** Сообщения консоли и ошибки страниц теста, кроме шума; к концу теста список обязан быть пуст. */
  readonly problems: string[];
}

export const test = base.extend<{ consoleWatch: ConsoleWatch }>({
  consoleWatch: [
    async ({ context, browser }, use, testInfo) => {
      const problems: string[] = [];
      const watch = (target: BrowserContext): void => {
        target.on('console', (message) => {
          const problem = consoleProblem(message.type(), message.text());
          if (problem !== null) problems.push(problem);
        });
        target.on('weberror', (error) => problems.push(`pageerror: ${error.error().message}`));
      };
      watch(context);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...args) => {
        const created = await newContext(...args);
        watch(created);
        return created;
      };
      try {
        await use({ problems });
      } finally {
        browser.newContext = newContext;
      }
      // Тело теста упало — его ошибка важнее; консоль — в отчёт. Прошло — консоль обязана быть пуста (и у test.fail()).
      if (testInfo.status !== 'passed') {
        if (problems.length > 0) testInfo.annotations.push({ type: 'консоль', description: problems.join('\n') });
        return;
      }
      if (problems.length > 0) throw new Error(`консоль не пуста:\n${problems.join('\n')}`);
    },
    { auto: true },
  ],
});
