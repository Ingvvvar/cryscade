// Показ раунда на странице для e2e (фаза 5): часы показа и принудительный раунд — через зонд (только dev и e2e-сборка).
// Общие для presentation.spec и frame-clock.spec.

import { expect, type Page } from '@playwright/test';
import type { PresentationInfo } from '../../src/ui/probe-api.ts';
import { waitForState } from './game-page.ts';
import type { ProbeWindow } from './page-probe.ts';

export async function presentation(page: Page): Promise<PresentationInfo | null> {
  return page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.presentation() ?? null);
}

export /** Сид следующего раунда: воркер ответил, что принял его, — только тогда «Спін». */
async function force(page: Page, round: 'feature' | 'multiplier'): Promise<void> {
  await page.evaluate(async (name) => {
    const probe = (window as ProbeWindow).__cryscadeProbe;
    if (probe === undefined) throw new Error('нет зонда');
    await probe.force(name);
  }, round);
}

export async function autoSkip(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as ProbeWindow).__cryscadeProbe?.autoSkip(true);
  });
}

export async function open(page: Page): Promise<void> {
  await page.goto('./');
  await waitForState(page, 'idle');
}

/** Показ идёт и дошёл хотя бы до группы group. */
export async function waitGroup(page: Page, group: number): Promise<PresentationInfo> {
  await expect.poll(async () => (await presentation(page))?.group ?? -1, { timeout: 20_000, message: `показ не дошёл до группы ${String(group)}` }).toBeGreaterThanOrEqual(group);
  const info = await presentation(page);
  if (info === null) throw new Error('показа нет');
  return info;
}
