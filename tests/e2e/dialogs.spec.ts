import { expect, test, type Page } from '@playwright/test';
import { labCall, readStorage, sentBodies, waitForState } from '../support/game-page.ts';
import { collectConsole } from '../support/page-probe.ts';

// Диалоги фазы 7 (§7, §11): правила и выплаты — из конфига модели, таблица 7 × 6 сверяется с литералами варианта 4 (§4.4);
// история — раунды IndexedDB, «Перевірити» после раскрытия секрета, «Відтворити» — ссылка повтора; честность —
// обязательство и nonce как в IndexedDB, смена сида раскрывает секрет, при активном раунде — отказ, панель пересчёта
// совпадает с раундом истории. Esc закрывает, фокус — на кнопке меню.

/** Таблица варианта 4 (§4.4) так, как её пишет украинская локаль: ниже 10× — две цифры после запятой. */
const PAYTABLE_UK = [
  ['0,95', '3,20', '6,90', '15', '26', '41'],
  ['0,95', '3,30', '7,90', '19', '36', '63'],
  ['0,95', '3,40', '9,00', '24', '51', '99'],
  ['0,95', '3,50', '10', '30', '72', '156'],
  ['0,95', '3,60', '12', '37', '101', '244'],
  ['0,95', '3,70', '13', '47', '143', '382'],
  ['0,95', '3,80', '15', '60', '201', '598'],
];

/** Иконка символа на странице: подпись, начало адреса, размер и средний цвет непрозрачных пикселей. */
interface IconLook {
  readonly alt: string;
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly opaque: number;
  readonly rgb: readonly [number, number, number];
}

function readIcons(page: Page, selector: string): Promise<IconLook[]> {
  return page.locator(selector).evaluateAll((nodes) =>
    Promise.all(
      nodes.map(async (node) => {
        const image = node as HTMLImageElement;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('нет canvas 2d');
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let opaque = 0;
        for (let at = 0; at < data.length; at += 4) {
          if ((data[at + 3] ?? 0) < 200) continue;
          r += data[at] ?? 0;
          g += data[at + 1] ?? 0;
          b += data[at + 2] ?? 0;
          opaque += 1;
        }
        const n = Math.max(opaque, 1);
        return { alt: image.alt, src: image.src, width: image.naturalWidth, height: image.naturalHeight, opaque, rgb: [r / n, g / n, b / n] as [number, number, number] };
      }),
    ),
  );
}

/** Оттенок HSV в градусах 0…360. */
function hue([r, g, b]: readonly [number, number, number]): number {
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (span === 0) return 0;
  const raw = max === r ? (g - b) / span : max === g ? 2 + (b - r) / span : 4 + (r - g) / span;
  return (raw * 60 + 360) % 360;
}

/** Оттенки камней по их названиям — общеизвестные цвета, а не палитра кода: [от, до) в градусах, через 0 — ruby. */
const STONE_HUES: readonly (readonly [number, string, number, number])[] = [
  [1, 'аметист — фиолетовый', 240, 300],
  [2, 'цитрин — жёлто-оранжевый', 25, 65],
  [3, 'смарагд — зелёный', 130, 175],
  [4, 'сапфир — синий', 200, 245],
  [5, 'рубин — красный', 330, 370],
];

interface FairnessStores {
  readonly fairness: { readonly commitment: string; readonly clientSeed: string; readonly nonce: number } | null;
  readonly secrets: readonly { readonly commitment: string; readonly secret: string; readonly revealedAt: number | null }[];
}

function readFairness(page: Page): Promise<FairnessStores> {
  return page.evaluate(
    () =>
      new Promise<FairnessStores>((resolve, reject) => {
        const request = indexedDB.open('cryscade');
        request.onerror = () => {
          reject(new Error(String(request.error)));
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['fairness', 'secrets'], 'readonly');
          const fairness = tx.objectStore('fairness').get('main');
          const secrets = tx.objectStore('secrets').getAll();
          tx.oncomplete = () => {
            db.close();
            resolve({ fairness: (fairness.result as FairnessStores['fairness'] | undefined) ?? null, secrets: secrets.result as FairnessStores['secrets'] });
          };
        };
      }),
  );
}

async function open(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: item }).click();
  await expect(page.getByRole('dialog', { name: item })).toBeVisible();
}

async function close(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Меню' })).toBeFocused();
}

async function spinOnce(page: Page, closed: number): Promise<void> {
  await page.getByRole('button', { name: 'Спін' }).click();
  await expect.poll(async () => (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length, { timeout: 15_000 }).toBe(closed);
  await waitForState(page, 'idle');
}

test('правила і виплати: таблиця 7 × 6 — літерали варіанта 4; числа правил — з конфігу; англійською — своя локаль', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await open(page, 'Правила і виплати');
  const table = page.getByTestId('paytable');
  await expect(table.locator('thead th')).toHaveText(['Кристал', '5–6', '7–8', '9–10', '11–12', '13–14', '15+']);
  // Иконки символов — кадры атласа живого рендерера (84 ед. × 2 = 168 px), alt — имя; ядро — в абзаце про фичу.
  await expect(table.locator('tbody th img')).toHaveCount(7);
  const icons = await readIcons(page, '[data-testid="paytable"] tbody th img');
  expect(icons.map((icon) => icon.alt)).toStrictEqual(['Кварц', 'Аметист', 'Цитрин', 'Смарагд', 'Сапфір', 'Рубін', 'Діамант']);
  expect(icons.map((icon) => [icon.src.slice(0, 22), icon.width, icon.height])).toStrictEqual(Array.from({ length: 7 }, () => ['data:image/png;base64,', 168, 168]));
  expect(new Set(icons.map((icon) => icon.src)).size, 'иконки разные').toBe(7);
  for (const icon of icons) expect(icon.opaque, `${icon.alt}: кристалл нарисован`).toBeGreaterThan(2000);
  for (const [symbol, stone, from, to] of STONE_HUES) {
    const look = icons[symbol];
    if (look === undefined) throw new Error(`нет иконки ${String(symbol)}`);
    const shade = hue(look.rgb);
    const turned = shade < from ? shade + 360 : shade;
    expect(turned, `${stone}: оттенок ${shade.toFixed(0)}°`).toBeGreaterThanOrEqual(from);
    expect(turned, `${stone}: оттенок ${shade.toFixed(0)}°`).toBeLessThan(to);
  }
  const [core] = await readIcons(page, '.rules p img');
  expect([core?.alt, core?.src.slice(0, 22), core?.width, core?.height]).toStrictEqual(['Ядро', 'data:image/png;base64,', 168, 168]);
  const coreHue = hue(core?.rgb ?? [0, 0, 0]);
  expect(coreHue, `ядро — бирюзовое: ${coreHue.toFixed(0)}°`).toBeGreaterThanOrEqual(160);
  expect(coreHue, `ядро — бирюзовое: ${coreHue.toFixed(0)}°`).toBeLessThan(200);
  const cells = await table.locator('tbody tr').evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent)));
  expect(cells).toStrictEqual(PAYTABLE_UK);
  const dialog = page.getByRole('dialog', { name: 'Правила і виплати' });
  await expect(dialog).toContainText('кластер — 5 і більше однакових кристалів');
  await expect(dialog).toContainText('до ×128');
  await expect(dialog).toContainText('фріспіни: 3 — 10, 4 — 12, 5 — 15, 6 і більше — 20.');
  await expect(dialog).toContainText('У фріспінах 3 ядра — ще 5 спінів.');
  await expect(dialog).toContainText(/Максимальний виграш раунду — 5\s000× ставки/);
  await close(page);
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Налаштування' }).click();
  await page.getByRole('radio', { name: 'English' }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Rules and payouts' }).click();
  await expect(page.getByTestId('paytable').locator('tbody tr')).toHaveCount(7);
  const english = await page
    .getByTestId('paytable')
    .locator('tbody tr')
    .evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent)));
  expect(english).toStrictEqual(PAYTABLE_UK.map((row) => row.map((cell) => cell.replace(',', '.'))));
  await expect(page.getByTestId('paytable').locator('tbody th img')).toHaveCount(7);
  expect(await page.getByTestId('paytable').locator('tbody th img').evaluateAll((nodes) => nodes.map((node) => (node as HTMLImageElement).alt))).toStrictEqual([
    'Quartz',
    'Amethyst',
    'Citrine',
    'Emerald',
    'Sapphire',
    'Ruby',
    'Diamond',
  ]);
  await expect(page.locator('.rules p img')).toHaveAttribute('alt', 'Core');
  await expect(page.getByRole('dialog', { name: 'Rules and payouts' })).toContainText(/maximum round win is 5,000× the bet/);
  expect(problems).toEqual([]);
});

test('історія: зіграні раунди — час, ставка, виграш, запис книги, nonce; до розкриття перевірки немає, після нового секрету — «Збігається»; «Відтворити» — посилання повтору', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await spinOnce(page, 1);
  await spinOnce(page, 2);
  const stored = [...(await readStorage(page)).rounds].sort((a, b) => b.seq - a.seq) as unknown as {
    roundId: string;
    betMinor: number;
    winMinor: number;
    bookIndex: number;
    nonce: number;
  }[];
  await open(page, 'Історія');
  const rows = page.getByTestId('history').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  const cells = await rows.evaluateAll((items) => items.map((row) => [row.getAttribute('data-round'), ...[...row.querySelectorAll('td')].slice(1, 6).map((cell) => cell.textContent)]));
  const money = (minor: number): string => `${String(Math.floor(minor / 100))},${String(minor % 100).padStart(2, '0')}`;
  expect(cells).toStrictEqual(stored.map((round) => [round.roundId, money(round.betMinor), money(round.winMinor), String(round.bookIndex), String(round.nonce), 'секрет ще не розкрито']));
  await expect(rows.first().getByRole('link', { name: 'Відтворити' })).toHaveAttribute('href', `?replay=round:${stored[0]?.roundId ?? ''}`);
  await close(page);
  await open(page, 'Чесність');
  await page.getByRole('button', { name: 'Новий секрет' }).click();
  await expect(page.getByTestId('revealed')).toBeVisible();
  await close(page);
  await open(page, 'Історія');
  // Строки — после ответа history: all() не ждёт, без этого цикл мог пройти по пустой таблице.
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await row.getByRole('button', { name: 'Перевірити' }).click();
    await expect(row.locator('.verdict')).toHaveText('Збігається');
  }
  expect((await sentBodies(page)).filter((body) => body.type === 'verify')).toHaveLength(2);
  expect(problems).toEqual([]);
});

test('чесність: зобов’язання і nonce — як в IndexedDB; сід не за форматом — підказка без запиту; під час раунду — відмова; зміна сіда розкриває секрет; панель перевірки збігається з раундом', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await spinOnce(page, 1);
  const before = await readFairness(page);
  const [round] = (await readStorage(page)).rounds as unknown as { bookIndex: number; payX100: number }[];
  await open(page, 'Чесність');
  await expect(page.getByTestId('commitment')).toHaveText(before.fairness?.commitment ?? '');
  await expect(page.getByTestId('nonce')).toHaveText('1');
  const seed = page.getByLabel('Сід гравця', { exact: true }).first();
  await seed.fill('a:b');
  await page.getByRole('button', { name: 'Змінити сід' }).click();
  await expect(page.getByText('Сід — від 1 до 64 знаків: латиниця й цифри')).toBeVisible();
  expect((await sentBodies(page)).filter((body) => body.type === 'setClientSeed')).toHaveLength(0);
  await close(page);
  // Активный раунд: ответ endRound задержан — смена сида получает ROUND_ACTIVE.
  await labCall(page, 'holdNextEndRound');
  await page.getByRole('button', { name: 'Спін' }).click();
  await expect.poll(async () => (await readStorage(page)).wallet?.activeRoundId ?? null).not.toBeNull();
  await open(page, 'Чесність');
  await page.getByRole('button', { name: 'Новий секрет' }).click();
  await expect(page.getByText('Раунд іще йде — змінити можна після нього')).toBeVisible();
  await close(page);
  await labCall(page, 'releaseHeld');
  await expect.poll(async () => (await readStorage(page)).rounds.filter((item) => item.status === 'closed').length).toBe(2);
  await waitForState(page, 'idle');
  await open(page, 'Чесність');
  // Поле смены сида — после ответа: до него первое поле «Сід гравця» — панели проверки.
  await expect(page.getByTestId('commitment')).toBeVisible();
  await seed.fill('Lucky7');
  await page.getByRole('button', { name: 'Змінити сід' }).click();
  // Запись раскрытия — до ответа setClientSeed: базу читаем, когда ответ уже на экране.
  await expect(page.getByTestId('revealed')).toBeVisible();
  const after = await readFairness(page);
  const old = after.secrets.find((item) => item.commitment === before.fairness?.commitment);
  await expect(page.getByTestId('revealed')).toHaveText(old?.secret ?? 'нет');
  expect(old?.revealedAt).not.toBeNull();
  await expect(page.getByTestId('commitment')).toHaveText(after.fairness?.commitment ?? '');
  await expect(page.getByTestId('nonce')).toHaveText('0');
  expect(after.fairness?.clientSeed).toBe('Lucky7');
  // Панель проверки уже держит раскрытый секрет и прежний сид; nonce 0 — первый раунд.
  await page.getByRole('button', { name: 'Перевірити раунд' }).click();
  const result = page.getByTestId('verify-result');
  await expect(result).toContainText(`Зобов’язання (SHA-256 секрету): ${before.fairness?.commitment ?? ''}`);
  await expect(result).toContainText(`Запис книги ${String(round?.bookIndex)}, виплата ×`);
  await expect(result).toContainText('Збігається з раундом');
  await page.getByLabel('Секрет').fill('xyz');
  await page.getByRole('button', { name: 'Перевірити раунд' }).click();
  await expect(result).toHaveText('Секрет — 64 знаки 0–9 і a–f');
  expect(problems).toEqual([]);
});

test('подменённый раунд: запись книги в IndexedDB переписана — проверка в історії і панель перевірки кажуть «Не збігається»', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await spinOnce(page, 1);
  const before = await readFairness(page);
  const [round] = (await readStorage(page)).rounds as unknown as { roundId: string; bookIndex: number }[];
  await open(page, 'Чесність');
  await page.getByRole('button', { name: 'Новий секрет' }).click();
  await expect(page.getByTestId('revealed')).toBeVisible();
  await close(page);
  // Подмена мимо сервера: тот же раунд, соседняя запись книги — гард записи её пропускает, честность — нет.
  const forged = (round?.bookIndex ?? 0) === 0 ? 1 : (round?.bookIndex ?? 1) - 1;
  await page.evaluate(
    ({ roundId, bookIndex }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('cryscade');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['rounds'], 'readwrite');
          const store = tx.objectStore('rounds');
          const read = store.get(roundId);
          read.onsuccess = () => {
            store.put({ ...(read.result as Record<string, unknown>), bookIndex });
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
    { roundId: round?.roundId ?? '', bookIndex: forged },
  );
  await open(page, 'Історія');
  const row = page.getByTestId('history').locator('tbody tr').first();
  await expect(row.locator('td').nth(3)).toHaveText(String(forged));
  await row.getByRole('button', { name: 'Перевірити' }).click();
  await expect(row.locator('.verdict')).toHaveText('Не збігається');
  await close(page);
  await open(page, 'Чесність');
  const secret = before.secrets.find((item) => item.commitment === before.fairness?.commitment)?.secret ?? '';
  await page.getByLabel('Секрет').fill(secret);
  await page.getByLabel('Сід гравця', { exact: true }).last().fill(before.fairness?.clientSeed ?? '');
  await page.getByLabel('nonce').fill('0');
  await page.getByRole('button', { name: 'Перевірити раунд' }).click();
  await expect(page.getByTestId('verify-result')).toContainText(`Запис книги ${String(round?.bookIndex)}`);
  await expect(page.getByTestId('verify-result')).toContainText('Не збігається з раундом');
  expect(problems).toEqual([]);
});
