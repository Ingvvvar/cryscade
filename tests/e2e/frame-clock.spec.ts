import { expect, test } from '../support/fixtures.ts';
import { waitForState } from '../support/game-page.ts';
import { collectConsole, type ProbeWindow } from '../support/page-probe.ts';
import { autoSkip, force, open, waitGroup } from '../support/presentation-page.ts';

// Часы кадра на месте (§8.2) — только Chromium: контроль теста — дробные дельты кадров, а WebKit отдаёт время кадра
// целыми миллисекундами, и контроль там не собрать (проба фазы 9). Округление дробного времени тикера держит и юнит
// (tests/unit/render/frame-clock.test.ts).

test('часы кадра на месте: тикер даёт дробные дельты, а часы показа — целые миллисекунды', async ({ page }) => {
  const { problems } = collectConsole(page);
  await open(page);
  await force(page, 'multiplier');
  await page.getByRole('button', { name: 'Спін' }).click();
  await waitGroup(page, 1);
  const sampled = await page.evaluate(async () => {
    const probe = (window as ProbeWindow).__cryscadeProbe;
    const stamps: number[] = [];
    const clocks: number[] = [];
    for (let k = 0; k < 30; k++) {
      stamps.push(await new Promise<number>((resolve) => requestAnimationFrame(resolve)));
      clocks.push(probe?.presentation()?.clock ?? Number.NaN);
    }
    return { stamps, clocks };
  });
  const deltas = sampled.stamps.slice(1).map((stamp, k) => stamp - (sampled.stamps[k] ?? stamp));
  expect(deltas.some((delta) => !Number.isInteger(delta)), 'контроль: дельты кадров здесь дробные').toBe(true);
  expect(new Set(sampled.clocks).size, 'часы показа шли').toBeGreaterThan(1);
  expect(sampled.clocks.filter((clock) => !Number.isInteger(clock)), 'часы показа — целые мс').toStrictEqual([]);
  await autoSkip(page);
  await waitForState(page, 'idle');
  expect(problems).toEqual([]);
});
