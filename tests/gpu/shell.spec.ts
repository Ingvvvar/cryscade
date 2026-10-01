import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import type { Dictionary, Language } from '../../src/ui/i18n/dictionary.ts';
import { EN } from '../../src/ui/i18n/en.ts';
import { UK } from '../../src/ui/i18n/uk.ts';
import { readStorage, waitForState } from '../support/game-page.ts';
import { sceneInfo, waitSettled, type ProbeWindow } from '../support/page-probe.ts';
import { PINNED_AMBIENT_S, snapshot } from './support/frame.ts';

// Оболочка фазы 7 (решение 12) — владельцу на глаз, в reports/phase-7/ с индексом «что смотреть»: панель, меню, каждый
// диалог и оба popover (ставка, автоигра) — портрет и ландшафт, украинский и английский. Перед снимками — два раунда:
// история не пустая. Декор закреплён; на программном рендере не снимаем.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${ROOT}reports/phase-7/`;
const DICTIONARIES: Readonly<Record<Language, Dictionary>> = { uk: UK, en: EN };

const FRAMES = {
  landscape: { viewport: { width: 1440, height: 900 }, dpr: 2 },
  portrait: { viewport: { width: 390, height: 844 }, dpr: 3 },
} as const;

interface Shot {
  readonly file: string;
  readonly look: string;
  readonly gpu: string;
}

const shots: Shot[] = [];

const DIALOGS = ['rules', 'settings', 'history', 'fairness', 'lab'] as const;

const LOOK: Readonly<Record<string, string>> = {
  panel: 'панель после двух раундов: подписи, суммы по локали, кнопка ставки, «Авто» и «Турбо»',
  menu: 'меню-popover: пять пунктов и сессия (результат, время); не наезжает ли на сетку',
  rules: 'правила и выплаты: текст правил с числами из конфига; таблица 7 × 6 — ниже, в прокрутке диалога (на телефоне её на первом экране нет)',
  settings: 'настройки: язык и правила гри; подсказка «со следующего раунда»',
  history: 'история: два раунда — время, ставка, выигрыш, запись книги, nonce, «Перевірити» / «Відтворити»',
  fairness: 'честность: обязательство (hex переносится), сид игрока, кнопки, панель проверки',
  lab: 'лаборатория сети: четыре поля и разовые действия',
  bet: 'выбор ставки: девять уровней, выбранный отмечен',
  autoplay: 'автоигра: 10 / 25 / 50 / 100, лимит потерь, флажки остановок, «Почати»',
};

async function settled(page: Page): Promise<void> {
  await waitSettled(page);
  await page.evaluate((seconds) => {
    (window as ProbeWindow).__cryscadeProbe?.pinAmbient(seconds);
  }, PINNED_AMBIENT_S);
  await page.waitForTimeout(150);
}

async function shoot(page: Page, name: string, frame: string, language: Language, gpu: string): Promise<void> {
  const { png } = await snapshot(page);
  const file = `${name}-${frame}-${language}.png`;
  writeFileSync(`${OUT}${file}`, png);
  shots.push({ file, look: LOOK[name] ?? name, gpu });
}

async function frameShots(browser: Browser, frame: keyof typeof FRAMES, language: Language): Promise<void> {
  const dict = DICTIONARIES[language];
  const { viewport, dpr } = FRAMES[frame];
  const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, reducedMotion: 'no-preference' });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cryscade:settings', value);
  }, JSON.stringify({ v: 1, language, preset: 'standard' }));
  const page = await context.newPage();
  await page.goto('./?renderer=webgl&autoskip=1');
  await waitForState(page, 'idle');
  const info = await sceneInfo(page);
  expect(info.name, 'фактический рендерер').toBe('webgl');
  expect(info.software, `программный рендер: ${info.gpu}`).toBe(false);
  for (const closed of [1, 2]) {
    await page.keyboard.press('Space');
    await expect.poll(async () => (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length, { timeout: 30_000 }).toBe(closed);
    await waitForState(page, 'idle');
  }
  await settled(page);
  await shoot(page, 'panel', frame, language, info.gpu);
  const menu = page.getByRole('button', { name: dict.text.menu });
  await menu.click();
  await expect(page.getByTestId('menu')).toBeVisible();
  await shoot(page, 'menu', frame, language, info.gpu);
  await page.keyboard.press('Escape');
  for (const name of DIALOGS) {
    await menu.click();
    await page.getByRole('button', { name: dict.text[name] }).click();
    await expect(page.getByRole('dialog', { name: dict.text[name] })).toBeVisible();
    await page.waitForTimeout(300);
    await shoot(page, name, frame, language, info.gpu);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.getByTestId('bet').click();
  await expect(page.getByTestId('bet-levels')).toBeVisible();
  await shoot(page, 'bet', frame, language, info.gpu);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: dict.text.auto }).click();
  await expect(page.getByTestId('autoplay')).toBeVisible();
  await shoot(page, 'autoplay', frame, language, info.gpu);
  await page.keyboard.press('Escape');
  await context.close();
}

mkdirSync(OUT, { recursive: true });

for (const frame of ['landscape', 'portrait'] as const) {
  for (const language of ['uk', 'en'] as const) {
    test(`${frame}, ${language}: панель, меню, диалоги и popover`, async ({ browser }) => {
      test.setTimeout(180_000);
      await frameShots(browser, frame, language);
    });
  }
}

test.afterAll(() => {
  const rows = shots.map((shot) => `| [${shot.file}](${shot.file}) | ${shot.look} |`);
  const index = [
    '# Фаза 7 — оболочка: что смотреть',
    '',
    'Снимки — `npm run shots` (`tests/gpu/shell.spec.ts`): после двух раундов, декор закреплён, WebGL.',
    `GPU: ${shots[0]?.gpu ?? '—'}.`,
    '',
    'Порядок: панель и меню, потом диалоги и popover — сначала ландшафт uk, потом en, потом портрет. Смотреть: всё ли',
    'читается и помещается на телефоне, не перекрывают ли полосы и popover нужное, как выглядят английские подписи.',
    '',
    '| Снимок | Что смотреть |',
    '|---|---|',
    ...rows,
    '',
  ].join('\n');
  writeFileSync(`${OUT}index.md`, index);
});
