// Настоящий StrictMode — dev-сборка React (§10): эффект монтируется дважды, а init рендерера асинхронный. Общее тело
// проверок для e2e (WebGL — Chromium и WebKit) и GPU-проекта (WebGPU — только на настоящем GPU, фаза 9).

import { expect, type Page } from '@playwright/test';
import { collectConsole, mountCounts, sceneInfo, waitSettled, type ProbeWindow } from './page-probe.ts';

/** Монтирований 2 — положительный контроль того, что двойной монтаж был; рендерер при этом создан один. */
export async function mountsOnce(page: Page, renderer: 'webgl' | 'webgpu'): Promise<void> {
  const { problems } = collectConsole(page);
  await page.goto(`./?renderer=${renderer}`);
  await waitSettled(page);
  expect(await mountCounts(page)).toStrictEqual({ attaches: 2, detaches: 1, created: 1, inits: 1, destroys: 0 });
  expect((await sceneInfo(page)).name).toBe(renderer);
  expect(await page.locator('canvas').count()).toBe(1);
  expect(problems).toEqual([]);
}

/**
 * Перемонтирование живой сцены — путь, на котором прежняя редакция §10 (канвас у React, removeView: false) вешала WebGL:
 * destroy теряет контекст, и init на том же канвасе не возвращается. Канвас — поколения рендерера.
 */
export async function remountsLive(page: Page, renderer: 'webgl' | 'webgpu'): Promise<void> {
  const { problems } = collectConsole(page);
  await page.goto(`./?renderer=${renderer}`);
  await waitSettled(page);
  await page.locator('canvas').evaluate((canvas) => {
    canvas.dataset['generation'] = 'first';
  });
  await page.evaluate(() => {
    (window as ProbeWindow).__cryscadeProbe?.remount();
  });
  await expect.poll(() => mountCounts(page), { timeout: 10_000 }).toStrictEqual({ attaches: 3, detaches: 2, created: 2, inits: 2, destroys: 1 });
  await waitSettled(page);
  expect(await page.locator('canvas').count()).toBe(1);
  expect(await page.locator('canvas[data-generation="first"]').count()).toBe(0);
  expect((await sceneInfo(page)).name).toBe(renderer);
  expect(problems).toEqual([]);
}
