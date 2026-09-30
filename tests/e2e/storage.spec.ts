import { expect, test, type Page } from '@playwright/test';
import { NON_KEYS, ORDERED_KEYS, buildKey, buildNonKey, describeKey, returnedSpec } from '../support/key-order-table.ts';
import { gameSnapshot, readStorage, reconciled, waitForState } from '../support/game-page.ts';
import { collectConsole } from '../support/page-probe.ts';

// Хранилище (§6.6) в настоящей IndexedDB: испорченное — сброс и полоса, недоступное — игра в памяти, versionchange —
// соединение закрыто и полоса, порядок ключей — по общей таблице, что и у хранилища в памяти. Состояние готовится
// записью в IndexedDB того же origin — синтетический ввод, чтобы привести игру в состояние.

const spinButton = (page: Page) => page.getByRole('button', { name: 'Спін' });

/** Пустая страница того же origin — чтобы готовить IndexedDB до запуска игры. */
async function blankOnOrigin(page: Page): Promise<void> {
  await page.route('**/cryscade/__blank', (route) => route.fulfill({ body: '<!doctype html><title>blank</title>', contentType: 'text/html' }));
  await page.goto('./__blank');
}

/** Записи в IndexedDB cryscade мимо игры: put и delete по хранилищам. */
async function plantRecords(page: Page, ops: readonly { readonly store: string; readonly put?: unknown; readonly delete?: string }[]): Promise<void> {
  await page.evaluate(
    (list) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('cryscade');
        request.onerror = () => {
          reject(new Error(String(request.error)));
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['wallet', 'rounds', 'keys'], 'readwrite');
          for (const op of list) {
            const store = tx.objectStore(op.store);
            if (op.delete !== undefined) store.delete(op.delete);
            else store.put(op.put);
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            reject(new Error(String(tx.error)));
          };
        };
      }),
    ops,
  );
}

/** Шесть спинов подряд без экрана ошибки: каждый доходит до idle. */
async function sixSpins(page: Page): Promise<void> {
  for (let spin = 0; spin < 6; spin++) {
    await spinButton(page).click();
    await expect.poll(async () => (await gameSnapshot(page)).state.name).toBe('idle');
    expect((await gameSnapshot(page)).state).toStrictEqual({ name: 'idle', refusal: null });
  }
}

const RESET_TEXT = 'Дані гри в браузері пошкоджено — баланс відновлено до 1000 кредитів';

test('испорченный кошелёк: сброс до 1000, полоса reset, шесть спинов без INTERNAL', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await plantRecords(page, [{ store: 'wallet', put: { id: 'main', balanceMinor: 'x', activeRoundId: null, nextSeq: 1, revision: 4, resetSeq: 1 } }]);
  await page.reload();
  const idle = await waitForState(page, 'idle');
  expect([idle.balanceMinor, idle.notice]).toStrictEqual([100_000, 'reset']);
  await expect(page.getByText(RESET_TEXT)).toBeVisible();
  await sixSpins(page);
  const stored = await readStorage(page);
  expect([stored.rounds.length, stored.quarantine]).toStrictEqual([6, 1]);
  expect(stored.wallet?.balanceMinor).toBe(reconciled(stored));
  expect(problems).toEqual([]);
});

test('раунд со строковым seq без кошелька: сброс, полоса reset, раунд в карантине, шесть спинов без INTERNAL', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  const junk = { roundId: 'junk', seq: 'x', idempotencyKey: 'kj', betMinor: 100, status: 'active' };
  await plantRecords(page, [
    { store: 'wallet', delete: 'main' },
    { store: 'rounds', put: junk },
    { store: 'keys', put: { key: 'kj', roundId: 'junk', betMinor: 100 } },
  ]);
  await page.reload();
  const idle = await waitForState(page, 'idle');
  expect([idle.balanceMinor, idle.notice]).toStrictEqual([100_000, 'reset']);
  await expect(page.getByText(RESET_TEXT)).toBeVisible();
  await sixSpins(page);
  const stored = await readStorage(page);
  expect(stored.rounds.map((round) => round.roundId)).not.toContain('junk');
  expect([stored.rounds.length, stored.keys, stored.quarantine]).toStrictEqual([6, 6, 1]);
  expect(stored.rounds.map((round) => round.seq).sort((x, y) => x - y)).toStrictEqual([1, 2, 3, 4, 5, 6]);
  expect(stored.wallet?.balanceMinor).toBe(reconciled(stored));
  expect(problems).toEqual([]);
});

test('IndexedDB недоступна (база версии 99): игра в памяти, полоса volatile, консоль пуста', async ({ page }) => {
  await blankOnOrigin(page);
  expect(
    await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const request = indexedDB.open('cryscade', 99);
          request.onerror = () => {
            reject(new Error(String(request.error)));
          };
          request.onsuccess = () => {
            const version = request.result.version;
            request.result.close();
            resolve(version);
          };
        }),
    ),
  ).toBe(99);
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  const idle = await waitForState(page, 'idle');
  expect([idle.balanceMinor, idle.notice]).toStrictEqual([100_000, 'volatile']);
  await expect(page.getByText('Сховище браузера недоступне: гра працює, але баланс і історія не збережуться після перезавантаження')).toBeVisible();
  await spinButton(page).click();
  await expect.poll(async () => (await gameSnapshot(page)).winMinor).not.toBeNull();
  expect((await waitForState(page, 'idle')).state).toStrictEqual({ name: 'idle', refusal: null });
  expect(problems).toEqual([]);
});

test('versionchange: вторая страница открывает cryscade версии 2 — первая закрыла соединение, показала полосу, спин выключен', async ({ context }) => {
  const a = await context.newPage();
  const { problems } = collectConsole(a);
  await a.goto('./?autoskip=1');
  await waitForState(a, 'idle');
  const b = await context.newPage();
  await blankOnOrigin(b);
  const upgraded = await b.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open('cryscade', 2);
        request.onupgradeneeded = (event) => {
          resolve(`обновлено ${String(event.oldVersion)} → ${String(event.newVersion)}`);
        };
        request.onerror = () => {
          reject(new Error(String(request.error)));
        };
      }),
  );
  expect(upgraded).toBe('обновлено 1 → 2');
  await expect(a.getByText('Гру оновлено в іншій вкладці — перезавантажте')).toBeVisible();
  expect((await gameSnapshot(a)).notice).toBe('versionchange');
  await expect(spinButton(a)).toBeDisabled();
  expect(problems).toEqual([]);
});

interface KeyOrderTools {
  readonly build: (spec: unknown) => unknown;
  readonly buildNon: (name: unknown) => unknown;
  readonly describe: (key: unknown) => unknown;
}

test('порядок ключей настоящей IndexedDB — по таблице хранилища в памяти; не-ключи не в индексе', async ({ page }) => {
  const { problems } = collectConsole(page);
  await blankOnOrigin(page);
  // Те же функции таблицы, что в Node-тесте, — на страницу исходником: без ссылок наружу они работают и там.
  await page.addScriptTag({
    content: `window.__keyOrder = { build: ${buildKey.toString()}, buildNon: ${buildNonKey.toString()}, describe: ${describeKey.toString()} };`,
  });
  const result = await page.evaluate(
    ([specs, nonKeys]) =>
      new Promise<{ readonly keys: unknown[]; readonly stored: number }>((resolve, reject) => {
        const { build, buildNon, describe } = (window as unknown as { readonly __keyOrder: KeyOrderTools }).__keyOrder;
        const request = indexedDB.open('cryscade-key-order', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('rounds', { keyPath: 'roundId' }).createIndex('seq', 'seq', { unique: true });
        };
        request.onerror = () => {
          reject(new Error(String(request.error)));
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('rounds', 'readwrite');
          const store = tx.objectStore('rounds');
          specs.forEach((spec, index) => store.put({ roundId: `k${String(index)}`, seq: build(spec) }));
          nonKeys.forEach((name) => store.put({ roundId: `n-${name}`, seq: buildNon(name) }));
          tx.oncomplete = () => {
            const keys: unknown[] = [];
            const read = db.transaction('rounds').objectStore('rounds');
            const count = read.count();
            const cursor = read.index('seq').openCursor(null, 'prev');
            cursor.onsuccess = () => {
              const at = cursor.result;
              if (at === null) {
                const stored = count.result;
                db.close();
                indexedDB.deleteDatabase('cryscade-key-order');
                resolve({ keys, stored });
                return;
              }
              keys.push(describe(at.key));
              at.continue();
            };
          };
        };
      }),
    [ORDERED_KEYS, NON_KEYS] as const,
  );
  expect(result.keys).toStrictEqual(ORDERED_KEYS.map(returnedSpec).reverse());
  expect(result.stored).toBe(ORDERED_KEYS.length + NON_KEYS.length);
  expect(problems).toEqual([]);
});
