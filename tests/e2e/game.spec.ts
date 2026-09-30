import { expect, test } from '@playwright/test';
import { fixtureFirstGrid } from '../support/fixture-rounds.ts';
import { gameSnapshot, readStorage, reconciled, waitForState } from '../support/game-page.ts';
import { collectConsole, waitSettled, type ProbeWindow } from '../support/page-probe.ts';

// Игра в браузере (§15, фаза 4): воркер с IndexedDB, Web Locks и BroadcastChannel, живая панель. e2e-сборка с зондом.
// Показ раунда пропускает зонд (?autoskip=1) тем же тапом, что у игрока: тесты не ждут показа (фаза 5).

test('первый спин: сетка покоя нового кошелька, спин, баланс по записи раунда в IndexedDB, консоль пуста', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  const idle = await waitForState(page, 'idle');
  expect(idle.grid).toStrictEqual(fixtureFirstGrid('feature-start'));
  expect(idle.balanceMinor).toBe(100_000);
  await expect(page.getByTestId('balance')).toHaveText('1 000,00');
  await expect(page.getByTestId('bet')).toHaveText('1,00');

  await page.getByRole('button', { name: 'Спін' }).click();
  await expect.poll(async () => (await gameSnapshot(page)).winMinor, { message: 'раунд не показан' }).not.toBeNull();
  const after = await waitForState(page, 'idle');
  const stored = await readStorage(page);
  expect(stored.rounds).toHaveLength(1);
  const [round] = stored.rounds;
  expect(round).toMatchObject({ seq: 1, status: 'closed', betMinor: 100 });
  expect(after.winMinor).toBe(round?.winMinor);
  expect(after.balanceMinor).toBe(100_000 - 100 + (round?.winMinor ?? 0));
  expect(stored.wallet).toMatchObject({ balanceMinor: after.balanceMinor, activeRoundId: null, nextSeq: 2, resetSeq: 1 });
  expect(reconciled(stored)).toBe(after.balanceMinor);
  expect(problems).toEqual([]);
});

test('до сетки покоя сцена не «встала»: сетку присылает authenticate, скрипт воркера задержан на 2 с', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.route('**/assets/worker-*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.continue();
  });
  await page.goto('./?autoskip=1');
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.info() ?? null)).not.toBeNull();
  // Падение пустой сетки заняло бы меньше секунды: через 1 с без сетки сцена всё ещё не в покое.
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.settled() ?? null)).toBe(false);
  await waitForState(page, 'idle');
  await waitSettled(page);
  expect(problems).toEqual([]);
});

test('воркер не загрузился — повтор поднимает новый: authenticate проходит со второго воркера', async ({ page }) => {
  const messages: string[] = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
  let workerLoads = 0;
  await page.route('**/assets/worker-*.js', async (route) => {
    workerLoads += 1;
    if (workerLoads === 1) await route.abort();
    else await route.continue();
  });
  await page.goto('./?autoskip=1');
  const idle = await waitForState(page, 'idle', 20_000);
  expect(idle.balanceMinor).toBe(100_000);
  expect(workerLoads).toBe(2);
  // Консоль — ровно отказ загрузки первого скрипта воркера, его пишет сам браузер.
  expect(messages.every((line) => line.includes('Failed to load resource'))).toBe(true);
});
