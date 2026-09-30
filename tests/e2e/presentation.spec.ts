import { expect, test, type Page } from '@playwright/test';
import type { PresentationInfo } from '../../src/ui/probe-api.ts';
import { gameSnapshot, readStorage, reconciled, sentBodies, waitForState } from '../support/game-page.ts';
import { collectConsole, type ProbeWindow } from '../support/page-probe.ts';

// Показ раунда (фаза 5, подход В): часы показа, featureIntro, пропуск, контрольная точка, скрытая вкладка, турбо и
// reduced motion — на настоящем воркере с IndexedDB. Нужный раунд задаёт зонд (force: сид следующего раунда мимо
// протокола, деньги идут обычным путём). Ввод — клик по координате сцены, пробел и кнопки панели.

const BET = 100;

async function presentation(page: Page): Promise<PresentationInfo | null> {
  return page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.presentation() ?? null);
}

/** Сид следующего раунда: воркер ответил, что принял его, — только тогда «Спін». */
async function force(page: Page, round: 'feature' | 'multiplier'): Promise<void> {
  await page.evaluate(async (name) => {
    const probe = (window as ProbeWindow).__cryscadeProbe;
    if (probe === undefined) throw new Error('нет зонда');
    await probe.force(name);
  }, round);
}

async function autoSkip(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as ProbeWindow).__cryscadeProbe?.autoSkip(true);
  });
}

/** Тап по середине сетки — кликом по координате: путь ввода тот же, что у игрока. */
async function tapScene(page: Page): Promise<void> {
  const cells = await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.cells() ?? []);
  const middle = cells[24];
  if (middle === undefined) throw new Error('нет клеток');
  await page.mouse.click(middle.x + middle.width / 2, middle.y + middle.height / 2);
}

async function open(page: Page): Promise<void> {
  await page.goto('./');
  await waitForState(page, 'idle');
}

/** Вкладка скрыта или видна — так, как это видит страница: document.hidden и событие visibilitychange. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { value, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: value ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** Показ идёт и дошёл хотя бы до группы group. */
async function waitGroup(page: Page, group: number): Promise<PresentationInfo> {
  await expect.poll(async () => (await presentation(page))?.group ?? -1, { timeout: 20_000, message: `показ не дошёл до группы ${String(group)}` }).toBeGreaterThanOrEqual(group);
  const info = await presentation(page);
  if (info === null) throw new Error('показа нет');
  return info;
}

test('фича на принудительном раунде: плашка ждёт игрока (featureIntro), пробел — показ дальше; деньги сходятся', async ({ page }) => {
  const { problems } = collectConsole(page);
  await open(page);
  await force(page, 'feature');
  await page.keyboard.press('Space');
  await waitForState(page, 'featureIntro', 20_000);
  const held = await presentation(page);
  expect(held?.held).toBe(true);
  // Часы стоят на точке удержания: через секунду — то же время, endRound не ушёл.
  await page.waitForTimeout(1000);
  expect((await presentation(page))?.clock).toBe(held?.clock);
  expect((await sentBodies(page)).map((body) => body.type)).toStrictEqual(['authenticate', 'play']);
  expect((await gameSnapshot(page)).balanceMinor).toBe(100_000 - BET);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await presentation(page))?.clock ?? 0).toBeGreaterThan(held?.clock ?? 0);
  await autoSkip(page);
  const after = await waitForState(page, 'idle');
  expect(after.balanceMinor).toBe(100_000 - BET + 2585);
  const stored = await readStorage(page);
  expect(stored.rounds.map((round) => [round.status, round.winMinor])).toStrictEqual([['closed', 2585]]);
  expect(after.balanceMinor).toBe(reconciled(stored));
  expect(problems).toEqual([]);
});

test('пропуск: клик по сцене — к концу группы, «Спін» во время показа — к концу раунда, endRound уходит сразу', async ({ page }) => {
  const { problems } = collectConsole(page);
  await open(page);
  await force(page, 'multiplier');
  await page.getByRole('button', { name: 'Спін' }).click();
  await waitGroup(page, 1);
  // Часы показа стоят, пока вкладка скрыта: пропуск меряется от места, где они стоят, без гонки с тикером.
  await setHidden(page, true);
  const first = await presentation(page);
  if (first === null) throw new Error('показа нет');
  expect(first.finished).toBe(false);
  await tapScene(page);
  const skipped = await presentation(page);
  expect(skipped?.clock, 'первый тап — ровно конец текущей группы').toBe(first.groupStarts[first.group + 1]);
  expect(skipped?.finished).toBe(false);
  // Второй тап — кнопкой «Спін»: во время показа она пропускает, а не крутит.
  await page.getByRole('button', { name: 'Спін' }).click();
  await expect.poll(async () => (await presentation(page))?.finished).toBe(true);
  expect((await presentation(page))?.clock).toBe(first.durationMs);
  await setHidden(page, false);
  expect((await sentBodies(page)).filter((body) => body.type === 'play')).toHaveLength(1);
  const after = await waitForState(page, 'idle');
  expect(after.balanceMinor).toBe(100_000 - BET + 1635);
  expect(problems).toEqual([]);
});

test('перезагрузка посреди каскада: показ продолжается с начала группы, деньги не сдвинулись ни на единицу', async ({ page }) => {
  const { problems } = collectConsole(page);
  await open(page);
  await force(page, 'multiplier');
  await page.getByRole('button', { name: 'Спін' }).click();
  const before = await waitGroup(page, 2);
  expect((await gameSnapshot(page)).state.name).toBe('presenting');
  await page.reload();
  // Доигрывание начинается со стадии замка (показа ещё нет) — ждём стадию показа.
  const stage = async (): Promise<string | null> => {
    const state = (await gameSnapshot(page).catch(() => null))?.state;
    return state?.name === 'restoring' ? state.stage : (state?.name ?? null);
  };
  await expect.poll(stage, { timeout: 15_000 }).toBe('show');
  const restored = await presentation(page);
  if (restored === null) throw new Error('показ не восстановлен');
  // Контрольная точка — индекс группы: показ начался с начала группы не раньше той, где была перезагрузка.
  expect(restored.groupStarts).toContain(restored.startMs);
  expect(restored.startMs).toBeGreaterThanOrEqual(before.groupStarts[before.group] ?? Number.POSITIVE_INFINITY);
  expect(restored.groupStarts).toStrictEqual(before.groupStarts);
  // До ответа endRound — баланс после ставки; ставка списана один раз.
  expect((await gameSnapshot(page)).balanceMinor).toBe(100_000 - BET);
  await autoSkip(page);
  const after = await waitForState(page, 'idle');
  const stored = await readStorage(page);
  expect(stored.rounds.map((round) => [round.status, round.betMinor, round.winMinor])).toStrictEqual([['closed', BET, 1635]]);
  expect(after.balanceMinor).toBe(100_000 - BET + 1635);
  expect(after.balanceMinor).toBe(reconciled(stored));
  expect((await sentBodies(page)).filter((body) => body.type === 'play')).toStrictEqual([]);
  expect(problems).toEqual([]);
});

test('скрытая вкладка: часы показа стоят; вкладка снова видна — идут дальше', async ({ page }) => {
  const { problems } = collectConsole(page);
  await open(page);
  await force(page, 'multiplier');
  await page.getByRole('button', { name: 'Спін' }).click();
  await waitGroup(page, 1);
  await setHidden(page, true);
  const stopped = (await presentation(page))?.clock;
  await page.waitForTimeout(700);
  expect((await presentation(page))?.clock).toBe(stopped);
  await setHidden(page, false);
  await expect.poll(async () => (await presentation(page))?.clock ?? 0).toBeGreaterThan(stopped ?? 0);
  await autoSkip(page);
  await waitForState(page, 'idle');
  expect(problems).toEqual([]);
});

test('турбо и reduced motion, переключённые посреди раунда, действуют со следующего', async ({ page }) => {
  const { problems } = collectConsole(page);
  await open(page);
  await force(page, 'multiplier');
  await page.getByRole('button', { name: 'Спін' }).click();
  await waitGroup(page, 1);
  await page.getByRole('button', { name: 'Турбо' }).click();
  await expect(page.getByRole('button', { name: 'Турбо' })).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const current = await presentation(page);
  expect([current?.speed, current?.reducedMotion]).toStrictEqual(['normal', false]);
  await autoSkip(page);
  await waitForState(page, 'idle');
  await page.getByRole('button', { name: 'Спін' }).click();
  await expect.poll(async () => (await gameSnapshot(page)).state.name).toBe('idle');
  const next = await presentation(page);
  expect([next?.speed, next?.reducedMotion]).toStrictEqual(['turbo', true]);
  expect(problems).toEqual([]);
});
