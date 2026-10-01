import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import type { ForcedName } from '../../src/ui/forced-rounds.ts';
import { readStorage, waitForState } from '../support/game-page.ts';
import { collectConsole, type ProbeWindow } from '../support/page-probe.ts';

// Рендеры App за раунд (§11, решение 9 фазы 7) — React Profiler вокруг App при зонде (e2e-сборка — профилирующий
// react-dom). Ввода по Tab нет — тест идёт и в WebKit (фаза 9); прежде жил в keyboard.spec, который только Chromium.

async function closedRounds(page: Page): Promise<number> {
  return (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length;
}

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
