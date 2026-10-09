import { type Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { dialogClosed, readStorage, reconciled, tapUntil } from '../support/game-page.ts';
import { collectConsole } from '../support/page-probe.ts';

// Лаборатория сети в прод-сборке (§6.5, решение 2 фазы 7): зонда нет — игра видна только через DOM и IndexedDB.
// Ревьюер на живом адресе ломает сеть диалогом, и деньги сходятся: потерянный ответ — повтор с тем же ключом, одно
// списание; перезагрузка посреди раунда — раунд доигран; потеря всех запросов — экран ошибки, денег не тронуто.

// Раунд из книги бывает фичей, и её плашка ждёт тапа — автопропуска в прод-сборке нет: тест, который только ждал
// закрытия раунда, раз на ~200 прогонов стоял на плашке до таймаута (прогон фазы 9, затем prod-lab-webkit в п.7).
// Поэтому, пока раунд не кончился, тест тапает по сцене, как игрок (tapUntil; доказательство — presentation.spec).

async function closedRounds(page: Page): Promise<number> {
  return (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length;
}

/** Покой без зонда: «Спін» доступен и не занят. */
async function idle(page: Page): Promise<void> {
  const spin = page.getByRole('button', { name: 'Спін' });
  await tapUntil(page, async () => (await spin.getAttribute('aria-busy')) === 'false' && (await spin.isEnabled()), '«Спін» не освободился');
}

/** Раунд доигран: закрытых раундов — count. */
async function playedOut(page: Page, count: number): Promise<void> {
  await tapUntil(page, async () => (await closedRounds(page)) === count, `закрытых раундов не ${String(count)}`);
}

async function labAction(page: Page, action: string, done: string): Promise<void> {
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Лабораторія мережі' }).click();
  await expect(page.getByRole('dialog', { name: 'Лабораторія мережі' })).toBeVisible();
  await page.getByRole('button', { name: action }).click();
  await expect(page.getByTestId('lab-status')).toHaveText(done);
  await page.keyboard.press('Escape');
  await dialogClosed(page);
}

test('загублена відповідь на play: гра повторює з тим самим ключем — один раунд, одне списання', async ({ page }) => {
  test.setTimeout(60_000);
  const { problems } = collectConsole(page);
  await page.goto('./');
  await idle(page);
  // «Загубити» теряет первый ответ с id; книгу страница запрашивает сама после первого кадра, и пока ответ на неё в пути,
  // потерялся бы он, а не play. Сначала целый раунд: play ждёт ту же книгу и отвечает после неё.
  await page.getByRole('button', { name: 'Спін' }).click();
  await playedOut(page, 1);
  await idle(page);
  await labAction(page, 'Загубити наступну відповідь', 'Наступна відповідь сервера загубиться — гра повторить запит з тим самим ключем');
  await page.getByRole('button', { name: 'Спін' }).click();
  await playedOut(page, 2);
  await idle(page);
  const stored = await readStorage(page);
  expect([stored.rounds.length, stored.keys]).toStrictEqual([2, 2]);
  expect(stored.wallet?.balanceMinor).toBe(reconciled(stored));
  expect(problems).toEqual([]);
});

test('перезавантаження посеред раунду: сторінка встає, раунд доіграно, гроші зійшлися', async ({ page }) => {
  test.setTimeout(60_000);
  const { problems } = collectConsole(page);
  await page.goto('./');
  await idle(page);
  await labAction(page, 'Перезавантажити посеред наступного раунду', 'Сторінка перезавантажиться, щойно сервер прийме наступну ставку');
  const reloaded = page.waitForEvent('load');
  await page.getByRole('button', { name: 'Спін' }).click();
  await reloaded;
  await idle(page);
  await expect.poll(() => closedRounds(page), { timeout: 30_000 }).toBe(1);
  const stored = await readStorage(page);
  expect(stored.rounds).toHaveLength(1);
  expect(stored.wallet?.balanceMinor).toBe(reconciled(stored));
  expect(problems).toEqual([]);
});

test('втрата всіх запитів: після повторів — екран «Сервер гри не відповідає», грошей не чіпано; перезавантаження — гра знову', async ({ page }) => {
  test.setTimeout(90_000);
  const { problems } = collectConsole(page);
  await page.goto('./');
  await idle(page);
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Лабораторія мережі' }).click();
  await page.getByLabel('Втрата запитів, %').fill('100');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Лабораторія мережі' }).click();
  await expect(page.getByLabel('Втрата запитів, %')).toHaveValue('100');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Спін' }).click();
  await expect(page.getByRole('alert')).toContainText('Сервер гри не відповідає', { timeout: 40_000 });
  await expect(page.getByRole('button', { name: 'Повторити' })).toBeVisible();
  const stored = await readStorage(page);
  expect([stored.rounds.length, stored.wallet?.balanceMinor]).toStrictEqual([0, 100_000]);
  await page.reload();
  await idle(page);
  await expect(page.getByTestId('balance')).toHaveText('1 000,00');
  expect(problems).toEqual([]);
});

test('затримка завершення раунду: раунд активний, доки затримане не відпустять; потім закрито, гроші зійшлися', async ({ page }) => {
  test.setTimeout(60_000);
  const { problems } = collectConsole(page);
  await page.goto('./');
  await idle(page);
  await labAction(page, 'Затримати наступне завершення раунду', 'Наступне завершення раунду чекатиме, доки його не відпустять');
  const spin = page.getByRole('button', { name: 'Спін' });
  await spin.click();
  await expect.poll(async () => (await readStorage(page)).wallet?.activeRoundId ?? null, { timeout: 30_000 }).not.toBeNull();
  // «Відпустити» отпускает только уже задержанное: раньше конца показа endRound ещё не ушёл, и его задержат навсегда.
  // Конец показа — «Спін» снова недоступен (endRound в пути).
  await expect(spin).toBeEnabled();
  await tapUntil(page, () => spin.isDisabled(), 'показ не кончился');
  // Показ кончился, endRound держит лаборатория: раунд активен, спин занят. Ждём дольше попытки клиента (3 с) и паузы
  // перед повтором (250 мс): повтор endRound тоже держится, раунд сам не закрывается (CI поймал повтор мимо задержки).
  await expect(spin).toHaveAttribute('aria-busy', 'true');
  await page.waitForTimeout(4500);
  expect([await closedRounds(page), (await readStorage(page)).wallet?.activeRoundId === null]).toStrictEqual([0, false]);
  await labAction(page, 'Відпустити затримане', 'Затримане відпущено');
  await expect.poll(() => closedRounds(page), { timeout: 15_000 }).toBe(1);
  await idle(page);
  const stored = await readStorage(page);
  expect(stored.wallet?.balanceMinor).toBe(reconciled(stored));
  expect(problems).toEqual([]);
});

test('затримка мережі: запит доходить до сервера не раніше за неї; поля зберігають значення; «Чиста мережа» — нулі', async ({ page }) => {
  test.setTimeout(60_000);
  const { problems } = collectConsole(page);
  await page.goto('./');
  await idle(page);
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Лабораторія мережі' }).click();
  // Сверх предела поля — предел: задержка не больше 5000 мс.
  await page.getByLabel('Затримка, мс').fill('9999');
  await expect(page.getByLabel('Затримка, мс')).toHaveValue('5000');
  await page.getByLabel('Затримка, мс').fill('1500');
  await page.getByLabel('Розкид, мс').fill('300');
  await page.getByLabel('Втрата відповідей, %').fill('5');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Лабораторія мережі' }).click();
  await expect(page.getByLabel('Затримка, мс')).toHaveValue('1500');
  await expect(page.getByLabel('Розкид, мс')).toHaveValue('300');
  await expect(page.getByLabel('Втрата відповідей, %')).toHaveValue('5');
  await page.getByLabel('Розкид, мс').fill('0');
  await page.getByLabel('Втрата відповідей, %').fill('0');
  await page.keyboard.press('Escape');
  const started = Date.now();
  await page.getByRole('button', { name: 'Спін' }).click();
  await expect.poll(async () => (await readStorage(page)).rounds.length, { timeout: 30_000, intervals: [50] }).toBe(1);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
  await playedOut(page, 1);
  await idle(page);
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Лабораторія мережі' }).click();
  await page.getByRole('button', { name: 'Чиста мережа' }).click();
  await expect(page.getByTestId('lab-status')).toHaveText('Мережа знову чиста');
  for (const label of ['Затримка, мс', 'Розкид, мс', 'Втрата запитів, %', 'Втрата відповідей, %']) await expect(page.getByLabel(label)).toHaveValue('0');
  expect(problems).toEqual([]);
});
