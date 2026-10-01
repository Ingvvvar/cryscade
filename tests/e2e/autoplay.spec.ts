import { type Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import type { ForcedName } from '../../src/ui/forced-rounds.ts';
import { labCall, readStorage, waitForState } from '../support/game-page.ts';
import { collectConsole, type ProbeWindow } from '../support/page-probe.ts';

// Автоигра (§11, решение 4 фазы 7): каждая остановка — с полосой и причиной. Раунды, от которых зависит остановка,
// принудительные (зонд e2e-сборки): проигрыш, фича, выигрыш 1.90×. Серия жмёт «Спін» сама; плашку фичи продолжает сама.

async function force(page: Page, round: ForcedName): Promise<void> {
  await page.evaluate((name) => (window as ProbeWindow).__cryscadeProbe?.force(name), round);
}

async function closed(page: Page): Promise<number> {
  return (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length;
}

interface Series {
  readonly count?: string;
  readonly lossLimit?: string;
  readonly stopOnFeature?: boolean;
  readonly winX?: string;
}

/** Popover «Авто»: настройки серии и «Почати». */
async function startSeries(page: Page, series: Series = {}): Promise<void> {
  await page.getByRole('button', { name: 'Авто' }).click();
  const form = page.getByTestId('autoplay');
  await expect(form).toBeVisible();
  if (series.count !== undefined) await form.getByRole('button', { name: series.count, exact: true }).click();
  if (series.lossLimit !== undefined) await form.getByLabel('Ліміт втрат, ставок').fill(series.lossLimit);
  if (series.stopOnFeature === false) await form.getByLabel('Зупинити на фріспінах').uncheck();
  if (series.winX !== undefined) {
    await form.getByRole('checkbox', { name: 'Зупинити на виграші від, × ставки' }).check();
    await form.getByRole('spinbutton', { name: 'Зупинити на виграші від, × ставки' }).fill(series.winX);
  }
  await form.getByRole('button', { name: 'Почати' }).click();
  await expect(form).toBeHidden();
}

const bar = (page: Page) => page.getByTestId('autoplay-bar');

test('серія до кінця: 10 спінів, смуга з ходом; кінець — «усі спіни зіграно», «Сховати» ховає', async ({ page }) => {
  test.setTimeout(60_000);
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await startSeries(page, { stopOnFeature: false });
  await expect(bar(page)).toContainText('Автогра: залишилось');
  await expect(page.getByRole('button', { name: 'Стоп' }).first()).toBeVisible();
  await expect(bar(page)).toContainText('Автогру завершено: усі спіни зіграно', { timeout: 45_000 });
  expect(await closed(page)).toBe(10);
  await bar(page).getByRole('button', { name: 'Сховати' }).click();
  await expect(bar(page)).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('ліміт втрат: 1 ставка, проигрыш — следующий спин не уходит', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await force(page, 'loss');
  await startSeries(page, { lossLimit: '1' });
  await expect(bar(page)).toContainText('Автогру зупинено: досягнуто ліміту втрат', { timeout: 15_000 });
  expect(await closed(page)).toBe(1);
  expect(problems).toEqual([]);
});

test('фріспіни: зупинка — після раунду фічі (плашку серія продовжує сама — юніт; тут плашку тапає і автопропуск)', async ({ page }) => {
  test.setTimeout(60_000);
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await force(page, 'feature');
  await startSeries(page);
  await expect(bar(page)).toContainText('Автогру зупинено: фріспіни', { timeout: 45_000 });
  expect(await closed(page)).toBe(1);
  expect(problems).toEqual([]);
});

// Без автопропуска плашку фичи не тапает никто, кроме серии: тест от «Почати» до остановки ничего не вводит. Ход
// состояний игры пишется в странице по кадрам — плашка стоит 800 мс серии (минус кадр опроса) и уходит сама.
test('фріспіни без автопропуску: плашку фічі серія продовжує сама — стоїть 800 мс і йде далі без вводу', async ({ page }) => {
  test.setTimeout(90_000);
  const { problems } = collectConsole(page);
  await page.goto('./');
  await waitForState(page, 'idle');
  await page.getByRole('button', { name: 'Турбо' }).click();
  await force(page, 'feature');
  await page.evaluate(() => {
    const w = window as ProbeWindow & { __states?: { name: string; at: number }[] };
    const states: { name: string; at: number }[] = [];
    w.__states = states;
    const sample = (): void => {
      const name = w.__cryscadeProbe?.game()?.state.name ?? 'none';
      if (states.at(-1)?.name !== name) states.push({ name, at: performance.now() });
      requestAnimationFrame(sample);
    };
    sample();
  });
  await startSeries(page);
  await expect(bar(page)).toContainText('Автогру зупинено: фріспіни', { timeout: 75_000 });
  const states = await page.evaluate(() => (window as ProbeWindow & { __states?: { name: string; at: number }[] }).__states ?? []);
  const intro = states.findIndex((state) => state.name === 'featureIntro');
  expect(intro, `плашка фичи была: ${states.map((state) => state.name).join(' → ')}`).toBeGreaterThan(-1);
  const stood = (states[intro + 1]?.at ?? Number.NaN) - (states[intro]?.at ?? Number.NaN);
  console.log(`плашка фичи стояла ${stood.toFixed(0)} мс; ход: ${states.map((state) => state.name).join(' → ')}`);
  expect(stood, 'плашка стоит 800 мс серии (кадр опроса — 20 мс)').toBeGreaterThanOrEqual(780);
  expect(stood, 'и уходит сама').toBeLessThan(2000);
  expect(states.filter((state) => state.name === 'featureIntro')).toHaveLength(1);
  expect(await closed(page)).toBe(1);
  expect(problems).toEqual([]);
});

test('фріспіни без зупинки на них: прапорець знято — серія йде далі після раунду фічі', async ({ page }) => {
  test.setTimeout(60_000);
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await force(page, 'feature');
  await startSeries(page, { stopOnFeature: false });
  await expect.poll(() => closed(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await expect(bar(page)).not.toContainText('фріспіни');
  await page.getByTestId('autoplay-bar').getByRole('button', { name: 'Стоп' }).click();
  await expect(bar(page)).toHaveText(/^Автогру зупинено/);
  expect(problems).toEqual([]);
});

test('виграш від N×: 1.90× при N = 1 — зупинка після раунду', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await force(page, 'baseWin');
  await startSeries(page, { winX: '1' });
  await expect(bar(page)).toContainText('Автогру зупинено: великий виграш', { timeout: 15_000 });
  expect(await closed(page)).toBe(1);
  expect(problems).toEqual([]);
});

test('помилка: усі запити губляться — після повторів екран помилки, серія зупинена з причиною', async ({ page }) => {
  test.setTimeout(60_000);
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await labCall(page, 'set', { requestLoss: 1 });
  await startSeries(page);
  await expect(bar(page)).toContainText('Автогру зупинено: помилка зв’язку з сервером', { timeout: 40_000 });
  expect([await closed(page), (await readStorage(page)).rounds.length]).toStrictEqual([0, 0]);
  expect(problems).toEqual([]);
});

test('недостатньо кредитів: баланс 1.50, проигрыш — второй спин сервер не принял, серия зупинена', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('cryscade');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['wallet'], 'readwrite');
          const store = tx.objectStore('wallet');
          const read = store.get('main');
          read.onsuccess = () => {
            const wallet = read.result as Record<string, number>;
            store.put({ ...wallet, balanceMinor: 150, revision: (wallet['revision'] ?? 0) + 1 });
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            reject(new Error(String(tx.error)));
          };
        };
      }),
  );
  await page.reload();
  await waitForState(page, 'idle');
  await expect(page.getByTestId('balance')).toHaveText('1,50');
  await force(page, 'loss');
  await startSeries(page);
  await expect(bar(page)).toContainText('Автогру зупинено: недостатньо кредитів', { timeout: 15_000 });
  expect([await closed(page), (await readStorage(page)).wallet?.balanceMinor]).toStrictEqual([1, 50]);
  expect(problems).toEqual([]);
});

test('раунд тримає інша вкладка: спін не пішов — серія зупинена з причиною, а не мовчки', async ({ page, context }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  const other = await context.newPage();
  await other.goto('./?autoskip=1');
  await waitForState(other, 'idle');
  await labCall(other, 'holdNextEndRound');
  await other.getByRole('button', { name: 'Спін' }).click();
  await expect.poll(async () => (await readStorage(other)).wallet?.activeRoundId ?? null).not.toBeNull();
  await waitForState(other, 'ending');
  await startSeries(page);
  await expect(bar(page)).toContainText('Автогру зупинено: раунд іде в іншій вкладці', { timeout: 15_000 });
  await labCall(other, 'releaseHeld');
  await waitForState(other, 'idle');
  expect(problems).toEqual([]);
});

test('гравець зупинив: «Стоп» — серія стоїть; строгі правила — «Авто» вимкнено', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./');
  await waitForState(page, 'idle');
  // Раунд, который идёт, когда игрок жмёт «Стоп», — проигрыш: случайная фича на обычной скорости шла бы дольше ожидания.
  await force(page, 'loss');
  await startSeries(page, { stopOnFeature: false });
  await expect(bar(page)).toContainText('Автогра: залишилось');
  await page.getByTestId('autoplay-bar').getByRole('button', { name: 'Стоп' }).click();
  await expect(bar(page)).toContainText('Автогру зупинено');
  await waitForState(page, 'idle', 30_000);
  const after = await closed(page);
  await page.waitForTimeout(1500);
  expect(await closed(page)).toBe(after);
  await page.goto('./?jurisdiction=strict');
  await waitForState(page, 'idle');
  await expect(page.getByRole('button', { name: 'Авто' })).toBeDisabled();
  expect(problems).toEqual([]);
});
