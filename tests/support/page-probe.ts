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

/**
 * Сообщения среды без GPU (§15, фаза 9; проба: Chromium с --disable-gpu и headless shell — модель CI): браузер пишет их
 * сам — «No available adapters.», когда откат спрашивает WebGPU, и «GPU stall due to ReadPixels», когда headless читает
 * кадр WebGL на SwiftShader. Игра в консоль не пишет ничего. Только эти шаблоны, целиком.
 */
export const BROWSER_ENVIRONMENT: readonly RegExp[] = [
  /^warning: No available adapters\.$/,
  /^warning: \[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels( \(this message will no longer repeat\))?$/,
];

/** Сообщение консоли — провал или нет: шум dev-сервера и сообщения среды — нет, всё прочее — да. */
export function consoleProblem(type: string, text: string): string | null {
  if ((type === 'debug' && text.startsWith('[vite]')) || (type === 'info' && text.includes('React DevTools'))) return null;
  const line = `${type}: ${text}`;
  return BROWSER_ENVIRONMENT.some((pattern) => pattern.test(line)) ? null : line;
}

/** Сообщения консоли и ошибки страницы; шум dev-сервера и сообщения среды — не провал. */
export function collectConsole(page: Page): { problems: string[] } {
  const problems: string[] = [];
  page.on('console', (message) => {
    const problem = consoleProblem(message.type(), message.text());
    if (problem !== null) problems.push(problem);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return { problems };
}
