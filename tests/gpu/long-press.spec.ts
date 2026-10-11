import { expect, test } from '@playwright/test';
import { emulate, idle, settle, touchHold } from '../support/touch-page.ts';

// Долгое касание «Спін» (прогон №6) — жестом браузера Chromium, путь пальца: :active и долгое нажатие. Локально, вне CI:
// на Linux в CI синтетическое касание до :active не доходит (CI 38156248243 и 38168834155: ни опрос, ни запись кадров
// нажатия не застали), там выделение держит вычисленный user-select (tests/e2e/touch.spec.ts) — как подсветку касания,
// которую инструмент не рисует вовсе. Только DOM, без зонда: идёт и на живом адресе.

test.describe('Android · Galaxy S5 · долгое касание', () => {
  test.use(emulate('Galaxy S5', 'портрет'));

  test('долгое касание «Спін» надпись не выделяет; разрешённое выделение то же касание выделяет (контроль)', async ({ page, context }) => {
    test.setTimeout(120_000);
    await page.goto('./');
    await idle(page);
    const cdp = await context.newCDPSession(page);
    const spin = page.getByRole('button', { name: 'Спін', exact: true });
    const held = await touchHold(cdp, spin);
    // Жест дошёл: кнопка была нажата — темнее и меньше, в своей форме; выделения нет.
    expect(held.frames, 'кадров нажатия').toBeGreaterThan(3);
    expect({ filter: held.filter, transform: held.transform, selection: held.selection }).toStrictEqual({ filter: 'brightness(0.8)', transform: 'matrix(0.95, 0, 0, 0.95, 0, 0)', selection: '' });
    await settle(page);
    // Положительный контроль: выделение разрешено — то же долгое касание выделяет надпись «Спін».
    await page.addStyleTag({ content: '.scene, .scene * { -webkit-user-select: text !important; user-select: text !important; }' });
    expect((await touchHold(cdp, spin)).selection.toUpperCase()).toContain('СПІН');
    await settle(page);
  });
});
