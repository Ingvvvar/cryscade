// Игра на странице для e2e: снимок контроллера и лаборатория сети через зонд (только dev и e2e-сборка), записи
// IndexedDB — прямо из страницы (тот же origin, что у воркера). Ввод — кликами по кнопкам панели.

import { expect, type Page } from '@playwright/test';
import type { ControllerSnapshot } from '../../src/client/index.ts';
import type { SentBody } from '../../src/ui/probe-api.ts';
import type { ProbeWindow } from './page-probe.ts';

/** Пустая страница того же origin — чтобы готовить IndexedDB до запуска игры. */
export async function blankOnOrigin(page: Page): Promise<void> {
  await page.route('**/cryscade/__blank', (route) => route.fulfill({ body: '<!doctype html><title>blank</title>', contentType: 'text/html' }));
  await page.goto('./__blank');
}

export async function gameSnapshot(page: Page): Promise<ControllerSnapshot> {
  const snapshot = await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.game() ?? null);
  if (snapshot === null) throw new Error('зонд не видит игру');
  return snapshot;
}

/**
 * Диалог закрыт до конца: элемента <dialog> больше нет. Роль dialog пропадает сразу по close(), а событие close — возврат
 * фокуса на кнопку меню и снятие диалога — отдельная задача, и Chromium пускает ввод раньше неё: клавиши, нажатые сразу,
 * доходили до игры, пока возврат фокуса ещё стоял в очереди, и он уводил фокус с того, куда их привели.
 */
export async function dialogClosed(page: Page): Promise<void> {
  await expect(page.locator('dialog')).toHaveCount(0);
}

/** Ждать состояния машины по имени. */
export async function waitForState(page: Page, name: ControllerSnapshot['state']['name'], timeout = 15_000): Promise<ControllerSnapshot> {
  await expect
    .poll(async () => (await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.game() ?? null))?.state.name ?? null, {
      timeout,
      message: `игра не пришла в ${name}`,
    })
    .toBe(name);
  return gameSnapshot(page);
}

/**
 * Тест как игрок: пока раунд не кончился (done), тапает по середине сцены — кликом по координате. Раунд из книги бывает
 * фичей (доля 4.9e-3), и её плашка ждёт тапа (featureIntro): тест, который только ждёт, простоял бы на ней до таймаута.
 * Тап во время показа — пропуск, в покое — ничего. Без зонда тоже: done читает DOM или IndexedDB (прод-сборка, lab.spec).
 */
export async function tapUntil(page: Page, done: () => Promise<boolean>, message: string, timeout = 60_000): Promise<void> {
  const size = page.viewportSize();
  if (size === null) throw new Error('нет размера окна');
  await expect
    .poll(
      async () => {
        if (await done()) return true;
        await page.mouse.click(size.width / 2, size.height / 2);
        return false;
      },
      { timeout, intervals: [250], message },
    )
    .toBe(true);
}

export interface StoredRound {
  readonly roundId: string;
  readonly seq: number;
  readonly status: string;
  readonly betMinor: number;
  readonly winMinor: number;
  readonly idempotencyKey: string;
}

export interface StoredState {
  readonly wallet: { readonly balanceMinor: number; readonly activeRoundId: string | null; readonly nextSeq: number; readonly resetSeq: number } | null;
  readonly rounds: readonly StoredRound[];
  readonly keys: number;
  readonly quarantine: number;
}

/** Записи IndexedDB cryscade как есть. Соединение закрывается сразу — обновлению базы оно не мешает. */
export function readStorage(page: Page): Promise<StoredState> {
  return page.evaluate(
    () =>
      new Promise<StoredState>((resolve, reject) => {
        const request = indexedDB.open('cryscade');
        request.onerror = () => {
          reject(new Error(String(request.error)));
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['wallet', 'rounds', 'keys', 'quarantine'], 'readonly');
          const wallet = tx.objectStore('wallet').get('main');
          const rounds = tx.objectStore('rounds').getAll();
          const keys = tx.objectStore('keys').count();
          const quarantine = tx.objectStore('quarantine').count();
          tx.oncomplete = () => {
            db.close();
            resolve({
              wallet: (wallet.result as StoredState['wallet'] | undefined) ?? null,
              rounds: rounds.result as StoredRound[],
              keys: keys.result,
              quarantine: quarantine.result,
            });
          };
        };
      }),
  );
}

/** Баланс по записям: 1000 − Σ ставок + Σ выигрышей закрытых раундов с seq ≥ resetSeq (§6.6). */
export function reconciled(state: StoredState): number {
  const resetSeq = state.wallet?.resetSeq ?? 1;
  return state.rounds
    .filter((round) => round.seq >= resetSeq)
    .reduce((balance, round) => balance - round.betMinor + (round.status === 'closed' ? round.winMinor : 0), 100_000);
}

/** Раунды, которые показала эта вкладка, по порядку: свои и доигранные. */
export async function shownRounds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.shownRounds() ?? []);
}

/** Тела запросов, ушедших в воркер после лаборатории сети: что на самом деле дошло до сервера. */
export async function sentBodies(page: Page): Promise<SentBody[]> {
  return page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.sent() ?? []);
}

/** Ответы воркера на запросы replay этой загрузки страницы — тело ответа как есть. */
export async function replays(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.replays() ?? []);
}

/** Запросы игры — без предзагрузки книги: её страница шлёт сама после первого кадра сцены (фаза 6). */
export async function gameCalls(page: Page): Promise<SentBody[]> {
  return (await sentBodies(page)).filter((body) => body.type !== 'loadBook');
}

type LabAction = 'loseNextResponse' | 'reloadMidNextRound' | 'holdNextEndRound' | 'releaseHeld';

/** Разовое действие лаборатории сети или её настройки. */
export async function labCall(page: Page, action: LabAction | 'set', settings?: Record<string, number>): Promise<void> {
  await page.evaluate(
    ([name, value]) => {
      const lab = (window as ProbeWindow).__cryscadeProbe?.lab;
      if (lab === undefined) throw new Error('нет зонда');
      if (name === 'set') lab.set(value ?? {});
      else lab[name]();
    },
    [action, settings] as const,
  );
}
