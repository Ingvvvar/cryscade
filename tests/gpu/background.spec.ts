import { expect, test, type Browser } from '@playwright/test';
import type { ProbeWindow } from '../support/page-probe.ts';
import { PINNED_AMBIENT_S, difference, openStill, snapshot } from './support/frame.ts';
import type { Image } from '../support/png.ts';

// Фон-шейдер (§9): пара GLSL и WGSL считает один кадр — паритет на пикселях при одном закреплённом времени.
// Контроль: сдвиг времени на WebGPU обязан выйти за порог. Reduced motion: время декора стоит само, без закрепления.

const PARITY_MEAN = 0.25 / 255;
const PARITY_MAX = 2 / 255;

async function backgroundFrame(browser: Browser, renderer: 'webgl' | 'webgpu', shift: number): Promise<Image> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await openStill(page, `?renderer=${renderer}`);
  await page.addStyleTag({ content: '.panel { display: none !important; }' });
  await page.evaluate((seconds) => {
    const probe = (window as ProbeWindow).__cryscadeProbe;
    probe?.backgroundOnly(true);
    probe?.pinAmbient(seconds);
  }, PINNED_AMBIENT_S + shift);
  await page.clock.runFor(100);
  const { image } = await snapshot(page);
  await context.close();
  return image;
}

test('паритет GLSL и WGSL: один кадр фона; сдвиг времени ловится', async ({ browser }) => {
  const webgl = await backgroundFrame(browser, 'webgl', 0);
  const webgpu = await backgroundFrame(browser, 'webgpu', 0);
  const shifted = await backgroundFrame(browser, 'webgpu', 0.8);
  const control = difference(shifted, webgl);
  const parity = difference(webgpu, webgl);
  console.log(`фон WebGL ↔ WebGPU: средняя ${(parity.mean * 255).toFixed(3)}/255, наибольшая ${(parity.max * 255).toFixed(0)}/255; контроль (+0.8 с): средняя ${(control.mean * 255).toFixed(3)}/255, наибольшая ${(control.max * 255).toFixed(0)}/255`);
  expect(control.max, 'контроль: сдвиг времени выходит за порог').toBeGreaterThan(PARITY_MAX);
  expect(control.mean, 'контроль: сдвиг времени выходит за порог').toBeGreaterThan(PARITY_MEAN);
  expect(parity.mean).toBeLessThanOrEqual(PARITY_MEAN);
  expect(parity.max).toBeLessThanOrEqual(PARITY_MAX);
});

for (const reduced of [true, false]) {
  test(`reduced motion ${reduced ? 'включён: кадр стоит без закрепления' : 'выключен (контроль): кадр идёт'}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    await openStill(page, '?renderer=webgl');
    await page.evaluate(() => {
      (window as ProbeWindow).__cryscadeProbe?.pinAmbient(null);
    });
    await page.clock.runFor(100);
    const a = await snapshot(page);
    await page.clock.runFor(1000);
    const b = await snapshot(page);
    const diff = difference(a.image, b.image);
    if (reduced) expect(diff.max).toBe(0);
    else expect(diff.max).toBeGreaterThan(0);
    await context.close();
  });
}
