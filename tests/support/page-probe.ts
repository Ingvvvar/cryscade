// Доступ к тестовому зонду страницы из Playwright. Зонд есть только в dev и e2e-сборке (src/ui/probe.ts).

import { expect, type Page } from '@playwright/test';
import type { CryscadeProbe, MountCounts, ProbeSceneInfo } from '../../src/ui/probe-api.ts';

export type ProbeWindow = Window & { __cryscadeProbe?: CryscadeProbe };

export async function waitSettled(page: Page, timeout = 15_000): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.settled() ?? false), { timeout, message: 'сетка не упала и не встала' })
    .toBe(true);
}

export async function sceneInfo(page: Page): Promise<ProbeSceneInfo> {
  const info = await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.info() ?? null);
  if (info === null) throw new Error('зонд не видит сцену: рендерер не дошёл до готовности');
  return info;
}

export async function mountCounts(page: Page): Promise<MountCounts> {
  const counts = await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.mounts() ?? null);
  if (counts === null) throw new Error('нет зонда: страница собрана без него');
  return counts;
}

/** Сообщения консоли и ошибки страницы; шум dev-сервера — отдельно, он не провал. */
export function collectConsole(page: Page): { problems: string[] } {
  const problems: string[] = [];
  const devNoise = (type: string, text: string): boolean =>
    (type === 'debug' && text.startsWith('[vite]')) || (type === 'info' && text.includes('React DevTools'));
  page.on('console', (message) => {
    if (!devNoise(message.type(), message.text())) problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return { problems };
}
