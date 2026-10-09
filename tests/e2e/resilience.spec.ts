import { type Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { gameSnapshot, labCall, readStorage, reconciled, sentBodies, shownRounds, waitForState } from '../support/game-page.ts';
import { collectConsole, type ProbeWindow } from '../support/page-probe.ts';

// Устойчивость (§6.5, §15 фаза 4): перезагрузка посреди раунда, потеря ответа, две вкладки на одном кошельке, перехват
// очередью и кнопкой. Вкладки — страницы одного контекста: общие IndexedDB, Web Locks и BroadcastChannel. Сбои — через
// лабораторию сети зонда; ввод — кликами по панели. Деньги сверяются по записям IndexedDB (§6.6). Показ раунда
// пропускает зонд (?autoskip=1) тем же тапом, что у игрока, — и после перезагрузок: тесты не ждут показа (фаза 5).

const spinButton = (page: Page) => page.getByRole('button', { name: 'Спін' });

async function open(page: Page): Promise<void> {
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
}

test('перезагрузка посреди раунда: после неё раунд доигран — одно списание, одно зачисление', async ({ page }) => {
  const { problems } = collectConsole(page);
  await open(page);
  await labCall(page, 'reloadMidNextRound');
  const reloaded = page.waitForEvent('load');
  await spinButton(page).click();
  await reloaded;
  const after = await waitForState(page, 'idle');
  const stored = await readStorage(page);
  expect(stored.rounds).toHaveLength(1);
  const [round] = stored.rounds;
  expect(round?.status).toBe('closed');
  expect(await shownRounds(page)).toStrictEqual([round?.roundId]);
  expect(after.winMinor).toBe(round?.winMinor);
  expect(after.balanceMinor).toBe(reconciled(stored));
  expect(problems).toEqual([]);
});

test('потеря ответа на play: повтор с тем же ключом получает тот же раунд — одно списание', async ({ page }) => {
  const { problems } = collectConsole(page);
  await open(page);
  // «Потерять следующий ответ» теряет первый ответ с id. Книгу страница запрашивает сама после первого кадра, и пока ответ
  // на неё в пути, потерялся бы он, а не play. Поэтому сначала целый раунд: play ждёт ту же книгу и отвечает после
  // loadBook — к покою после раунда ответ на книгу уже пришёл.
  await spinButton(page).click();
  await expect.poll(async () => (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length).toBe(1);
  await waitForState(page, 'idle');
  await labCall(page, 'loseNextResponse');
  await spinButton(page).click();
  // Ответ потерян: попытка истекает через 3 с, повтор — через 250 мс.
  await expect.poll(async () => (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length, { timeout: 15_000 }).toBe(2);
  const after = await waitForState(page, 'idle', 15_000);
  const plays = (await sentBodies(page)).filter((body) => body.type === 'play');
  expect(plays).toHaveLength(3);
  expect(plays[2]).toStrictEqual(plays[1]);
  expect(plays[1]?.idempotencyKey).not.toBe(plays[0]?.idempotencyKey);
  const stored = await readStorage(page);
  expect([stored.rounds.length, stored.keys]).toStrictEqual([2, 2]);
  expect(stored.rounds.filter((round) => round.idempotencyKey === plays[1]?.idempotencyKey)).toHaveLength(1);
  expect(after.balanceMinor).toBe(reconciled(stored));
  expect(problems).toEqual([]);
});

/** Крутить, пока вкладка не покажет count раундов. Спин, нажатый, пока раунд у другой вкладки, не продолжается (§6.5). */
async function spinUntil(page: Page, count: number): Promise<void> {
  while ((await shownRounds(page)).length < count) {
    await spinButton(page).click({ timeout: 20_000 });
  }
  await waitForState(page, 'idle');
}

test('две вкладки по 30 спинов: баланс сходится до минимальной единицы, у обеих — баланс кошелька', async ({ context }) => {
  test.setTimeout(120_000);
  const a = await context.newPage();
  const b = await context.newPage();
  const consoles = [collectConsole(a), collectConsole(b)];
  await open(a);
  await open(b);
  await Promise.all([spinUntil(a, 30), spinUntil(b, 30)]);
  const stored = await readStorage(a);
  const [shownA, shownB] = [await shownRounds(a), await shownRounds(b)];
  expect(stored.rounds.length).toBeGreaterThanOrEqual(60);
  expect(stored.rounds.every((round) => round.status === 'closed')).toBe(true);
  expect(stored.wallet?.balanceMinor).toBe(reconciled(stored));
  await expect.poll(async () => [(await gameSnapshot(a)).balanceMinor, (await gameSnapshot(b)).balanceMinor]).toStrictEqual([
    stored.wallet?.balanceMinor,
    stored.wallet?.balanceMinor,
  ]);
  // Каждый раунд показан ровно одной вкладкой: ни второго показа, ни потерянного.
  expect(new Set([...shownA, ...shownB]).size).toBe(shownA.length + shownB.length);
  expect([...shownA, ...shownB].sort()).toStrictEqual(stored.rounds.map((round) => round.roundId).sort());
  expect(consoles.flatMap((console) => console.problems)).toEqual([]);
});

test('перехват очередью: A держит раунд (endRound задержан), B ждёт; A закрылась — B доигрывает её раунд', async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  const { problems } = collectConsole(b);
  await open(a);
  await open(b);
  await labCall(a, 'holdNextEndRound');
  await spinButton(a).click();
  const ending = await waitForState(a, 'ending');
  const roundId = ending.state.name === 'ending' ? ending.state.roundId : null;
  await spinButton(b).click();
  await waitForState(b, 'waitingForTab');
  await expect(b.getByRole('button', { name: 'Грати тут' })).toBeEnabled();
  await a.close();
  const after = await waitForState(b, 'idle');
  expect(await shownRounds(b)).toStrictEqual([roundId]);
  const stored = await readStorage(b);
  expect(stored.rounds.map((round) => [round.roundId, round.status])).toStrictEqual([[roundId, 'closed']]);
  expect(after.balanceMinor).toBe(reconciled(stored));
  expect(problems).toEqual([]);
});

test('перехват кнопкой: A жива, B «Грати тут» доигрывает; A ждёт; брошенный ключ A больше не уходит; деньги сходятся', async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  const consoles = [collectConsole(a), collectConsole(b)];
  await open(a);
  await open(b);
  // Ответы A теряются: её play дошёл и записан, а сама A ждёт ответа и будет повторять тот же ключ.
  await labCall(a, 'set', { responseLoss: 1 });
  await spinButton(a).click();
  await expect.poll(async () => (await sentBodies(a)).filter((body) => body.type === 'play').length).toBe(1);
  await spinButton(b).click();
  await waitForState(b, 'waitingForTab');
  // B доигрывает раунд A с автопропуском за доли секунды и отдаёт замок: A прошла бы ожидание и встала в authenticate с
  // теряющимися ответами раньше, чем тест её увидит. Конец раунда B держит лаборатория — замок у B, пока A ждёт.
  await labCall(b, 'holdNextEndRound');
  await b.getByRole('button', { name: 'Грати тут' }).click();
  await waitForState(a, 'waitingForTab');
  await labCall(a, 'set', { responseLoss: 0 });
  await waitForState(b, 'ending');
  await labCall(b, 'releaseHeld');
  const afterB = await waitForState(b, 'idle');
  const [abandoned] = (await sentBodies(a)).filter((body) => body.type === 'play');
  // Окно, в котором A повторила бы play (таймаут 3 с + пауза 250 мс), — наблюдаем отсутствие повтора, не ждём исхода.
  await a.waitForTimeout(3500);
  expect((await sentBodies(a)).filter((body) => body.type === 'play')).toStrictEqual([abandoned]);
  const afterA = await waitForState(a, 'idle');
  const stored = await readStorage(b);
  expect(stored.rounds.map((round) => [round.idempotencyKey, round.status])).toStrictEqual([[abandoned?.idempotencyKey, 'closed']]);
  expect(await shownRounds(b)).toStrictEqual(stored.rounds.map((round) => round.roundId));
  expect(await shownRounds(a)).toStrictEqual([]);
  expect([afterA.balanceMinor, afterB.balanceMinor]).toStrictEqual([reconciled(stored), reconciled(stored)]);
  expect(consoles.flatMap((console) => console.problems)).toEqual([]);
});

type StatesWindow = ProbeWindow & { __states?: string[] };

/** Журнал смен состояния вкладки — из самой страницы, раз в миллисекунду: опрос теста столько не видит. */
async function recordStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as StatesWindow;
    const states: string[] = [];
    scope.__states = states;
    window.setInterval(() => {
      const name = scope.__cryscadeProbe?.game()?.state.name ?? 'none';
      if (states.at(-1) !== name) states.push(name);
    }, 1);
  });
}

const statesOf = (page: Page): Promise<string[]> => page.evaluate(() => [...((window as StatesWindow).__states ?? [])]);

// Быстрый путь того же перехвата (решение 6 прогона №3, проба 20/20 в Chromium и WebKit): конец раунда B никто не держит,
// B доигрывает раунд A с автопропуском за доли секунды и отдаёт замок раньше, чем опрос теста увидел бы A в ожидании, —
// A проходит ожидание сразу в authenticate. Тест не ждёт ожидания A: прежний тест ждал и запирал сам себя.
test('перехват кнопкой, быстрый путь: B доигрывает раунд A быстрее опроса A; брошенный ключ A не уходит; деньги сходятся', async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  const consoles = [collectConsole(a), collectConsole(b)];
  await open(a);
  await open(b);
  await labCall(a, 'set', { responseLoss: 1 });
  await spinButton(a).click();
  await expect.poll(async () => (await sentBodies(a)).filter((body) => body.type === 'play').length).toBe(1);
  await spinButton(b).click();
  await waitForState(b, 'waitingForTab');
  await recordStates(a);
  await b.getByRole('button', { name: 'Грати тут' }).click();
  const afterB = await waitForState(b, 'idle');
  const whenBIdle = await statesOf(a);
  await labCall(a, 'set', { responseLoss: 0 });
  const [abandoned] = (await sentBodies(a)).filter((body) => body.type === 'play');
  // Окно, в котором A повторила бы play (таймаут 3 с + пауза 250 мс), — наблюдаем отсутствие повтора, не ждём исхода.
  await a.waitForTimeout(3500);
  expect((await sentBodies(a)).filter((body) => body.type === 'play')).toStrictEqual([abandoned]);
  const afterA = await waitForState(a, 'idle');
  console.log(`быстрый перехват: состояния A к покою B — ${whenBIdle.join(' → ')}; все — ${(await statesOf(a)).join(' → ')}`);
  const stored = await readStorage(b);
  expect(stored.rounds.map((round) => [round.idempotencyKey, round.status])).toStrictEqual([[abandoned?.idempotencyKey, 'closed']]);
  expect(await shownRounds(b)).toStrictEqual(stored.rounds.map((round) => round.roundId));
  expect(await shownRounds(a)).toStrictEqual([]);
  expect([afterA.balanceMinor, afterB.balanceMinor]).toStrictEqual([reconciled(stored), reconciled(stored)]);
  expect(consoles.flatMap((console) => console.problems)).toEqual([]);
});

test('«Поповнити»: ставка больше баланса — INSUFFICIENT_FUNDS, «Поповнити» — 1000', async ({ page }) => {
  const { problems } = collectConsole(page);
  await open(page);
  // Кошелёк с 0,50 — синтетически, записью в IndexedDB того же origin; перезагрузка — чтобы authenticate его прочёл.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('cryscade');
        request.onerror = () => {
          reject(new Error(String(request.error)));
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('wallet', 'readwrite');
          tx.objectStore('wallet').put({ id: 'main', balanceMinor: 50, activeRoundId: null, nextSeq: 1, revision: 1, resetSeq: 1 });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      }),
  );
  await page.reload();
  await waitForState(page, 'idle');
  await expect(page.getByTestId('balance')).toHaveText('0,50');
  await spinButton(page).click();
  await expect(page.getByText('Недостатньо кредитів для ставки — поповніть баланс')).toBeVisible();
  expect((await gameSnapshot(page)).state).toStrictEqual({ name: 'idle', refusal: 'INSUFFICIENT_FUNDS' });
  await page.getByRole('button', { name: 'Поповнити' }).click();
  await expect(page.getByTestId('balance')).toHaveText('1 000,00');
  const stored = await readStorage(page);
  expect(stored.wallet).toMatchObject({ balanceMinor: 100_000, resetSeq: 1 });
  expect(stored.rounds).toStrictEqual([]);
  expect(problems).toEqual([]);
});
