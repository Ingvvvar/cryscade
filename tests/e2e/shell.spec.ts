import { expect, test, type Page } from '@playwright/test';
import type { ShownRound } from '../../src/client/index.ts';
import type { SceneLabels } from '../../src/render/renderer.ts';
import { FORCED_SEEDS } from '../../src/ui/forced-rounds.ts';
import { MoneyFormat } from '../../src/ui/money-format.ts';
import { gameSnapshot, readStorage, waitForState, type StoredState } from '../support/game-page.ts';
import { collectConsole, type ProbeWindow } from '../support/page-probe.ts';
import { fixtureShown, seedShown } from '../support/shown-rounds.ts';

// Оболочка фазы 7 (§11): настройки — язык сразу, правила гри (пресет) — со следующего раунда, ?jurisdiction= сильнее
// настройки; сессия вкладки — в строгом пресете на экране, в обычном — в меню; переживает перезагрузку, у новой вкладки
// своя. Диалог — нативный <dialog>: Esc закрывает, фокус возвращается на кнопку меню.

/** Чистый результат закрытых раундов — по записям IndexedDB, своим путём: «+12,50», «−3,00», «0,00». */
function expectedNet(state: StoredState, locale: string): string {
  const net = state.rounds.filter((round) => round.status === 'closed').reduce((sum, round) => sum + round.winMinor - round.betMinor, 0);
  const money = new MoneyFormat(locale);
  return net === 0 ? money.format(0) : `${net > 0 ? '+' : '−'}${money.format(Math.abs(net))}`;
}

async function openSettings(page: Page, menu: string, settings: string): Promise<void> {
  await page.getByRole('button', { name: menu }).click();
  await page.getByRole('button', { name: settings }).click();
  await expect(page.getByRole('dialog', { name: settings })).toBeVisible();
}

/** Кадр показа стоит на доле share сегмента segment группы group раунда round; тикер остановлен, кадр отрисован. */
async function hold(page: Page, round: ShownRound, segment: string, group: string, share: number): Promise<SceneLabels | null> {
  return page.evaluate(
    ({ shown, kind, groupKind, at }) => {
      const probe = (window as ProbeWindow).__cryscadeProbe;
      if (probe === undefined) throw new Error('нет зонда');
      probe.stopTicker();
      probe.still(shown, 0);
      const schedule = probe.schedule();
      const target = schedule?.segments.find((item) => item.kind === kind && schedule.groups[item.group]?.kind === groupKind);
      if (target === undefined) throw new Error(`нет сегмента ${kind}`);
      probe.still(shown, Math.floor(target.startMs + (target.endMs - target.startMs) * at));
      probe.renderOnce();
      return probe.sceneLabels();
    },
    { shown: round, kind: segment, groupKind: group, at: share },
  );
}

/** Тот же кадр ещё раз — после смены языка. */
async function redraw(page: Page): Promise<SceneLabels | null> {
  return page.evaluate(() => {
    const probe = (window as ProbeWindow).__cryscadeProbe;
    probe?.renderOnce();
    return probe?.sceneLabels() ?? null;
  });
}

async function spinOnce(page: Page, closed: number): Promise<void> {
  await page.keyboard.press('Space');
  await expect.poll(async () => (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length, { timeout: 15_000 }).toBe(closed);
  await waitForState(page, 'idle');
}

test('настройки: английский — панель, суммы и надписи сцены сразу, и на кадре, что уже стоит; Esc закрывает, фокус — на меню; выбор переживает перезагрузку', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  const retrigger = fixtureShown('retrigger');
  const bigWin = seedShown(FORCED_SEEDS.bigWin1);
  const intro = await hold(page, fixtureShown('feature-start'), 'plaqueIn', 'feature', 1);
  expect([intro?.plaque, intro?.hint]).toStrictEqual(['Фріспіни', 'Натисніть, щоб продовжити']);
  const uk = await hold(page, retrigger, 'plaqueIn', 'retrigger', 1);
  expect([uk?.freeSpins, uk?.plaque, uk?.counter.includes(',')]).toStrictEqual(['Фріспіни', '+5 фріспінів', true]);
  const celebration = await hold(page, bigWin, 'celebrate', 'bigWin', 0.5);
  expect(celebration?.bigWin).toBe('Великий виграш');
  const ukCounter = celebration?.counter ?? '';
  expect(ukCounter).toMatch(/^\d+,\d\d$/);
  await openSettings(page, 'Меню', 'Налаштування');
  await expect(page.getByRole('radio', { name: 'Українська' })).toBeFocused();
  await page.getByRole('radio', { name: 'English' }).check();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Spin' })).toBeVisible();
  await expect(page.getByTestId('balance')).toHaveText('1,000.00');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
  // Кадр большого выигрыша стоит с украинского: после смены языка — английская надпись и точка в той же сумме.
  const same = await redraw(page);
  expect([same?.bigWin, same?.counter]).toStrictEqual(['Big win', ukCounter.replace(',', '.')]);
  // Плашка ретриггера та же, что была по-украински: надпись — заново, по-английски.
  const en = await hold(page, retrigger, 'plaqueIn', 'retrigger', 1);
  expect([en?.freeSpins, en?.plaque, en?.counter.includes('.')]).toStrictEqual(['Free spins', '+5 free spins', true]);
  const introEn = await hold(page, fixtureShown('feature-start'), 'plaqueIn', 'feature', 1);
  expect([introEn?.plaque, introEn?.hint]).toStrictEqual(['Free spins', 'Tap to continue']);
  await page.reload();
  await waitForState(page, 'idle');
  await expect(page.getByRole('button', { name: 'Spin' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cryscade:settings'))).toBe('{"v":1,"language":"en","preset":"standard"}');
  expect(problems).toEqual([]);
});

test('правила гри: строгі — турбо выключено и сессия на экране сразу, цикл спина от 2500 мс; переживают перезагрузку; ?jurisdiction=standard сильнее настройки', async ({ page }) => {
  test.setTimeout(60_000);
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await expect(page.locator('.session-top')).toHaveCount(0);
  await openSettings(page, 'Меню', 'Налаштування');
  await expect(page.getByText('Діють з наступного раунду')).toBeVisible();
  await page.getByRole('radio', { name: 'Строгі (модель UKGC)' }).check();
  await page.keyboard.press('Escape');
  await expect(page.locator('.session-top')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cryscade' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Турбо' })).toBeDisabled();
  // Фокус вернулся на кнопку меню — пробел нажал бы её; спин — кнопкой.
  await page.getByRole('button', { name: 'Спін' }).click();
  await expect.poll(async () => (await gameSnapshot(page)).state.name).toBe('presenting');
  const duration = await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.schedule()?.durationMs ?? 0);
  expect(duration).toBeGreaterThanOrEqual(2500);
  await expect.poll(async () => (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length, { timeout: 30_000 }).toBe(1);
  await waitForState(page, 'idle');
  const net = expectedNet(await readStorage(page), 'uk-UA');
  await expect(page.locator('.session-top [data-testid="session-net"]')).toHaveText(net);
  const time = page.locator('.session-top [data-testid="session-time"]');
  await expect(time).toHaveText(/^00:\d\d$/);
  // Время идёт само, раз в секунду.
  const shown = await time.textContent();
  await expect(time).not.toHaveText(shown ?? '', { timeout: 3000 });
  await page.reload();
  await waitForState(page, 'idle');
  await expect(page.locator('.session-top [data-testid="session-net"]')).toHaveText(net);
  await page.goto('./?autoskip=1&jurisdiction=standard');
  await waitForState(page, 'idle');
  await expect(page.locator('.session-top')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Турбо' })).toBeEnabled();
  await openSettings(page, 'Меню', 'Налаштування');
  await expect(page.getByRole('radio', { name: 'Звичайні' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Строгі (модель UKGC)' })).toBeDisabled();
  await expect(page.getByText('Задано посиланням — налаштування їх не змінює')).toBeVisible();
  expect(problems).toEqual([]);
});

test('сессия в обычном пресете — в меню: результат закрытых раундов этой вкладки; переживает перезагрузку, у новой вкладки — своя', async ({ page, context }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await spinOnce(page, 1);
  await spinOnce(page, 2);
  const net = expectedNet(await readStorage(page), 'uk-UA');
  await page.getByRole('button', { name: 'Меню' }).click();
  const menuNet = page.getByTestId('menu').getByTestId('session-net');
  await expect(menuNet).toHaveText(net);
  await page.reload();
  await waitForState(page, 'idle');
  await page.getByRole('button', { name: 'Меню' }).click();
  await expect(menuNet).toHaveText(net);
  const fresh = await context.newPage();
  await fresh.goto('./?autoskip=1');
  await waitForState(fresh, 'idle');
  await fresh.getByRole('button', { name: 'Меню' }).click();
  await expect(fresh.getByTestId('menu').getByTestId('session-net')).toHaveText('0,00');
  expect(problems).toEqual([]);
});
