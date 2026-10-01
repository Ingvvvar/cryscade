import { expect, test, type Page } from '@playwright/test';
import { type AudioCounts, type AudioWindow, installAudioCounter } from '../support/audio-counter.ts';
import { readStorage, waitForState } from '../support/game-page.ts';

// Замер утечек звука (§12, решение 6 фазы 8): две минуты живой игры — автоигра, обычная скорость, плашку фичи серия
// продолжает сама. Ноды по типам и запущенные против завершённых источников. После серии и хвостов огибающих живы
// только два долгих источника фона — шум и модуляция; больше — утечка. Положительный контроль — ?soundleak=1: голос
// запускает лишний источник на каждый сигнал и не останавливает — замер обязан это поймать.

const PLAY_MS = 120_000;
/** Долгие источники фона: шум одного буфера и медленная модуляция фильтра. */
const AMBIENCE_SOURCES = 2;

async function counts(page: Page): Promise<AudioCounts> {
  const found = await page.evaluate(() => {
    const value = (window as AudioWindow).__audioCounts;
    return value === undefined ? null : { ...value, created: { ...value.created } };
  });
  if (found === null) throw new Error('счётчик WebAudio не установлен');
  return found;
}

async function playLive(page: Page, query: string): Promise<{ readonly counts: AudioCounts; readonly rounds: number }> {
  await page.addInitScript(installAudioCounter);
  await page.goto(`./${query}`);
  await waitForState(page, 'idle');
  // Жест — «Авто»: контекст создаётся в нём; серия — 100 спинов, лимит потерь 1000 ставок, без остановки на фиче.
  await page.getByRole('button', { name: 'Авто' }).click();
  const form = page.getByTestId('autoplay');
  await form.getByRole('button', { name: '100', exact: true }).click();
  await form.getByLabel('Ліміт втрат, ставок').fill('1000');
  await form.getByLabel('Зупинити на фріспінах').uncheck();
  await form.getByRole('button', { name: 'Почати' }).click();
  await page.waitForTimeout(PLAY_MS);
  await page.getByTestId('autoplay-bar').getByRole('button', { name: 'Стоп' }).click();
  await waitForState(page, 'idle', 120_000);
  // Хвосты огибающих — до 2 с; ended приходит после stop.
  await page.waitForTimeout(3000);
  const rounds = (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length;
  return { counts: await counts(page), rounds };
}

function report(name: string, measured: { readonly counts: AudioCounts; readonly rounds: number }): number {
  const { counts: audio, rounds } = measured;
  const active = audio.started - audio.ended;
  const created = Object.entries(audio.created)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type} ${String(count)}`)
    .join(', ');
  console.log(`${name}: раундов ${String(rounds)}; создано: ${created}; источников запущено ${String(audio.started)}, завершено ${String(audio.ended)}, живы ${String(active)}`);
  return active;
}

test('две минуты живой игры: живы только два источника фона; ноды — по сигналам', async ({ page }) => {
  test.setTimeout(PLAY_MS + 240_000);
  const measured = await playLive(page, '');
  const active = report('игра', measured);
  expect(measured.rounds).toBeGreaterThan(5);
  expect(measured.counts.contexts).toBe(1);
  expect(measured.counts.created['Buffer']).toBe(1);
  expect(measured.counts.started).toBeGreaterThan(50);
  expect(active).toBe(AMBIENCE_SOURCES);
});

test('контроль: источник без stop на каждый сигнал — замер ловит рост', async ({ page }) => {
  test.setTimeout(PLAY_MS + 240_000);
  const active = report('контроль ?soundleak=1', await playLive(page, '?soundleak=1'));
  expect(active).toBeGreaterThan(AMBIENCE_SOURCES + 50);
});
