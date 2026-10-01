import { type Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { type AudioCounts, type AudioWindow, installAudioCounter } from '../support/audio-counter.ts';
import { readStorage, waitForState } from '../support/game-page.ts';
import { collectConsole } from '../support/page-probe.ts';

// Звук (§12, решения 1, 3 и 5 фазы 8) в браузере — без ушей, по счётчику WebAudio: до жеста контекста нет; первый жест —
// контекст запущен, фон звучит, раунд даёт сигналы; мьют — новых источников нет; скрытая вкладка — контекст на паузе.

async function counts(page: Page): Promise<AudioCounts> {
  const found = await page.evaluate(() => {
    const scope = window as AudioWindow;
    const value = scope.__audioCounts;
    return value === undefined ? null : { ...value, created: { ...value.created }, states: (scope.__audioContexts ?? []).map((context) => context.state) };
  });
  if (found === null) throw new Error('счётчик WebAudio не установлен');
  return found;
}

async function spinOnce(page: Page, closed: number): Promise<void> {
  await page.getByRole('button', { name: 'Спін' }).click();
  await expect.poll(async () => (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length, { timeout: 30_000 }).toBe(closed);
  await waitForState(page, 'idle');
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { value, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: value ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('до жеста контекста нет; первый жест — контекст запущен, фон звучит, раунд даёт сигналы', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.addInitScript(installAudioCounter);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  expect((await counts(page)).contexts).toBe(0);
  await spinOnce(page, 1);
  await expect.poll(async () => (await counts(page)).states).toStrictEqual(['running']);
  // Фон: шум одного буфера по кругу и медленная модуляция — два долгих источника; сигналы раунда — осцилляторы.
  await expect.poll(async () => (await counts(page)).created['BufferSource'] ?? 0).toBe(1);
  const ready = await counts(page);
  expect([ready.contexts, ready.created['Buffer']]).toStrictEqual([1, 1]);
  await spinOnce(page, 2);
  expect((await counts(page)).created['Oscillator'] ?? 0).toBeGreaterThan(ready.created['Oscillator'] ?? 0);
  expect(problems).toEqual([]);
});

test('мьют: ♪ выключен (перечёркнут) — раунд без новых источников; включён — сигналы снова; настройка «Звук» — та же', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.addInitScript(installAudioCounter);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  const note = page.getByRole('button', { name: 'Звук' });
  await expect(note).toHaveAttribute('aria-pressed', 'true');
  await expect(note).toHaveCSS('text-decoration-line', 'none');
  await note.click();
  await expect(note).toHaveAttribute('aria-pressed', 'false');
  // Выключенный звук видно глазами: ♪ перечёркнут.
  await expect(note).toHaveCSS('text-decoration-line', 'line-through');
  // Голос готов, когда ленивый модуль построил фон: буфер шума и его источник — до базы счёта.
  await expect.poll(async () => (await counts(page)).created['BufferSource'] ?? 0).toBe(1);
  const muted = await counts(page);
  await spinOnce(page, 1);
  expect((await counts(page)).created['Oscillator']).toBe(muted.created['Oscillator']);
  await note.click();
  await expect(note).toHaveAttribute('aria-pressed', 'true');
  await expect(note).toHaveCSS('text-decoration-line', 'none');
  await spinOnce(page, 2);
  expect((await counts(page)).created['Oscillator'] ?? 0).toBeGreaterThan(muted.created['Oscillator'] ?? 0);
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Налаштування' }).click();
  await page.getByRole('checkbox', { name: 'Увімкнено' }).uncheck();
  await page.keyboard.press('Escape');
  await expect(note).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('cryscade:settings'))).toBe('{"v":1,"language":"uk","preset":"standard","sound":false}');
  expect(problems).toEqual([]);
});

test('скрытая вкладка — контекст на паузе; видна — снова идёт', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.addInitScript(installAudioCounter);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await spinOnce(page, 1);
  await expect.poll(async () => (await counts(page)).states).toStrictEqual(['running']);
  await setHidden(page, true);
  await expect.poll(async () => (await counts(page)).states).toStrictEqual(['suspended']);
  await setHidden(page, false);
  await expect.poll(async () => (await counts(page)).states).toStrictEqual(['running']);
  expect(problems).toEqual([]);
});
