// Касания на телефоне (§11, прогон №6): игра на странице глазами браузера — только DOM, без зонда, поэтому тот же тест
// идёт и на живом адресе. Ввод — касанием по координате (touchscreen), с клавиатуры — Tab. Решения «квадрат 44 × 44» и
// «рамка по форме» — в touch-targets.ts, здесь — что о них знает страница.

import { devices, expect, type CDPSession, type Locator, type Page } from '@playwright/test';
import { decodePng } from './png.ts';
import { ringReport, signedDistance, verdict, type HitMap, type Rect, type RingReport, type Shape, type Verdict } from './touch-targets.ts';

export type Orientation = 'портрет' | 'ландшафт';

/** Сторона области нажатия, CSS-пиксели. */
export const SIDE = 44;

/** Контекст устройства Playwright: вьюпорт, касания, мобильная разметка. Браузер задаёт проект. */
export function emulate(name: string, orientation: Orientation): {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly userAgent: string;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
} {
  const key = orientation === 'портрет' ? name : `${name} landscape`;
  const device = devices[key];
  if (device === undefined) throw new Error(`нет устройства «${key}»`);
  return { viewport: device.viewport, userAgent: device.userAgent, deviceScaleFactor: device.deviceScaleFactor, isMobile: device.isMobile, hasTouch: device.hasTouch };
}

const SPIN = 'Спін';

/** Игра в покое — по DOM: «Спін» включён и не занят. */
export async function idle(page: Page, timeout = 30_000): Promise<void> {
  const spin = page.getByRole('button', { name: SPIN, exact: true });
  await expect(spin).toBeEnabled({ timeout });
  await expect(spin).toHaveAttribute('aria-busy', 'false', { timeout });
}

/** Раунд доигран: касания по сцене, пока «Спін» не освободится (плашка фичи ждёт тапа, показ пропускается). */
export async function settle(page: Page, timeout = 90_000): Promise<void> {
  const spin = page.getByRole('button', { name: SPIN, exact: true });
  await expect
    .poll(
      async () => {
        if ((await spin.isEnabled()) && (await spin.getAttribute('aria-busy')) === 'false') return true;
        await tapScene(page);
        return false;
      },
      { timeout, intervals: [250], message: 'раунд не кончился' },
    )
    .toBe(true);
}

/**
 * Касание по середине видимой части элемента — по координате, с настоящим попаданием по слоям. Внутри диалога и popover
 * элемент сначала прокручивается в видимую область; панель не прокручивается: документ прокрутился бы вместе с ней.
 */
export async function tap(page: Page, target: Locator): Promise<void> {
  const inside = await target.evaluate((element) => element.closest('dialog, [popover]') !== null);
  if (inside) await target.scrollIntoViewIfNeeded();
  const box = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const left = Math.max(rect.left, 0);
    const top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, window.innerWidth);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    return { x: (left + right) / 2, y: (top + bottom) / 2, seen: right > left && bottom > top };
  });
  if (!box.seen) throw new Error('элемент вне окна');
  await page.touchscreen.tap(box.x, box.y);
}

/**
 * Касание по сцене — в точку, где сверху канвас или его хост (тап слушает хост), а не popover или кнопка: popover так
 * закрывается сам (light dismiss), в покое сцене тап ничего не делает, во время показа — пропуск. Точку ищет страница:
 * от середины экрана к краям.
 */
export async function tapScene(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    for (let ring = 0; ring < 10; ring++) {
      for (let step = 0; step < 8; step++) {
        const angle = (step / 8) * 2 * Math.PI;
        const x = window.innerWidth * (0.5 + 0.045 * ring * Math.cos(angle));
        const y = window.innerHeight * (0.4 + 0.045 * ring * Math.sin(angle));
        const hit = document.elementFromPoint(x, y);
        if (hit !== null && (hit.classList.contains('scene-canvas') || hit.classList.contains('scene-host'))) return { x, y, middle: '' };
      }
    }
    const middle = document.elementFromPoint(window.innerWidth / 2, window.innerHeight * 0.4);
    return { x: -1, y: -1, middle: middle === null ? 'null' : `${middle.tagName}.${middle.className}` };
  });
  if (point.x < 0) throw new Error(`сцены не видно: в середине экрана ${point.middle}`);
  await page.touchscreen.tap(point.x, point.y);
}

/**
 * Видимые рамки: у каждого элемента страницы, у которого outline рисуется. Рамки в игре — только фокуса, и рамка
 * радио и флажка — у строки выбора, а не у поля в фокусе: поэтому смотрим все элементы, а не только :focus-visible.
 */
export function rings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    return [...document.querySelectorAll('*')]
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
      })
      .map((element) => `${element.tagName}:${(element.getAttribute('aria-label') ?? element.textContent).replace(/\s+/g, ' ').trim().slice(0, 30)}`);
  });
}

/** Подсветка касания браузера — вычисленным стилем: у корня, сцены и каждого элемента управления — прозрачная. */
export function tapHighlights(page: Page): Promise<{ readonly scanned: number; readonly colored: string[] }> {
  return page.evaluate(() => {
    const all = [document.documentElement, document.body, ...document.querySelectorAll('#root, .scene, .scene-host, canvas, button, a[href], label, input, dialog, [popover]')];
    const colored = all
      .map((element) => ({ element, colour: getComputedStyle(element).getPropertyValue('-webkit-tap-highlight-color') }))
      .filter((item) => item.colour !== 'rgba(0, 0, 0, 0)')
      .map((item) => `${item.element.tagName}.${item.element.className}: ${item.colour}`);
    return { scanned: all.length, colored };
  });
}

/** Гигиена касаний вычисленным стилем: appearance у кнопок, touch-action у элементов управления и сцены, выделение. */
export function hygiene(page: Page): Promise<{
  readonly buttons: number;
  readonly appearance: string[];
  readonly touchAction: string[];
  readonly selectable: string[];
  readonly dialogText: string | null;
}> {
  return page.evaluate(() => {
    const name = (element: Element): string => `${element.tagName}.${element.className}`;
    const buttons = [...document.querySelectorAll('button')];
    const controls = [...document.querySelectorAll('button, a[href], input, label, .scene-host')];
    const select = (element: Element): string => {
      const style = getComputedStyle(element);
      return style.getPropertyValue('-webkit-user-select') === 'none' || style.getPropertyValue('user-select') === 'none' ? 'none' : 'text';
    };
    const scene = [...document.querySelectorAll('.scene-host, .scene-canvas, .panel, .panel .zone button, .panel .label, .panel .value')];
    const text = document.querySelector('dialog[open] .modal-body');
    return {
      buttons: buttons.length,
      appearance: buttons.filter((button) => getComputedStyle(button).appearance !== 'none').map(name),
      touchAction: controls.filter((element) => getComputedStyle(element).touchAction !== 'manipulation' && element.tagName !== 'CANVAS').map(name),
      selectable: scene.filter((element) => select(element) !== 'none').map(name),
      dialogText: text === null ? null : select(text),
    };
  });
}

/** Текст стилей, которые отдала страница: свойства только iOS (-webkit-touch-callout) CSSOM настольных движков отбрасывает. */
export function shippedCss(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((link) => link.href);
    const fetched = await Promise.all(links.map((href) => fetch(href).then((response) => response.text())));
    return [...fetched, ...[...document.querySelectorAll('style')].map((style) => style.textContent)].join('\n');
  });
}

interface Measured {
  readonly name: string;
  readonly map: HitMap;
  /** Видимая форма элемента. */
  readonly shape: Shape;
  readonly neighbours: readonly Shape[];
  /** Сетка попаданий по рамке элемента, шаг 2 px: чья каждая точка. */
  readonly grid: readonly { readonly x: number; readonly y: number; readonly owner: number }[];
}

/** Край формы, где попадание браузера шире рамки (замер прогона №6): точки ближе — не в счёт. */
const INSIDE = -1.5;

/** Итог области нажатия по набору элементов: сколько найдено, что не прошло, где — заслон соседа или края. */
export interface TargetCheck {
  readonly count: number;
  readonly problems: string[];
  readonly blocked: string[];
}

/**
 * Область нажатия каждого видимого элемента набора: карта попаданий 88 × 88 вокруг центра (шаг 1 px). blocked разрешён
 * только тем, чьё имя начинается с одного из allowed: где видимые соседи или край экрана ближе 22 px (замер прогона №6).
 */
export async function checkTargets(page: Page, selector: string, scrolled: boolean, allowed: readonly string[]): Promise<TargetCheck> {
  const measured = await page.evaluate(
    ({ selector: query, scrolled: scroll, side }) => {
      const controls = [...document.querySelectorAll<HTMLElement>(query)].filter(
        (element) => element.getClientRects().length > 0 && !(element as HTMLButtonElement).disabled && getComputedStyle(element).visibility !== 'hidden',
      );
      const index = new Map(controls.map((element, at) => [element, at] as const));
      const owner = (element: Element | null): number => {
        for (let node = element; node !== null; node = node.parentElement) {
          const at = index.get(node as HTMLElement);
          if (at !== undefined) return at;
        }
        return -1;
      };
      const shapeOf = (element: Element): Shape => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const radius = (value: string): number => {
          const [horizontal = '0', vertical = horizontal] = value.split(' ');
          const px = (token: string, base: number): number => (token.endsWith('%') ? (Number.parseFloat(token) / 100) * base : Number.parseFloat(token) || 0);
          return Math.min(px(horizontal, rect.width), px(vertical, rect.height));
        };
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          radii: [radius(style.borderTopLeftRadius), radius(style.borderTopRightRadius), radius(style.borderBottomRightRadius), radius(style.borderBottomLeftRadius)],
        };
      };
      return controls.map((control, me) => {
        if (scroll) control.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = control.getBoundingClientRect();
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const span = 2 * side;
        const owners: number[] = [];
        for (let y = 0; y < span; y++) {
          for (let x = 0; x < span; x++) {
            const px = cx - side + x + 0.5;
            const py = cy - side + y + 0.5;
            // Внутри окна под точкой всегда есть хотя бы <html>; null — край окна: эмуляция Chromium не попадает в последнюю
            // полупиксельную строку (y = 359.5 при высоте 360) — точку не нажать.
            const hit = px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight ? null : document.elementFromPoint(px, py);
            owners.push(hit === null ? -2 : owner(hit));
          }
        }
        // Видимая форма — своя: невидимая область соседа под ней не лежит. Сетка с шагом 2 px по рамке элемента; что
        // внутри формы, решает signedDistance в Node.
        const own = shapeOf(control);
        const grid: { x: number; y: number; owner: number }[] = [];
        for (let py = own.y + 1; py < own.y + own.height; py += 2) {
          for (let px = own.x + 1; px < own.x + own.width; px += 2) {
            if (px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight) continue;
            const hit = document.elementFromPoint(px, py);
            if (hit !== null) grid.push({ x: px, y: py, owner: owner(hit) });
          }
        }
        return {
          name: (control.getAttribute('aria-label') ?? control.textContent).replace(/\s+/g, ' ').trim(),
          map: { cx, cy, span, owners },
          shape: own,
          neighbours: controls.filter((_, other) => other !== me).map(shapeOf),
          grid,
        };
      });
    },
    { selector, scrolled, side: SIDE },
  );
  return judge(measured, allowed);
}

function judge(measured: readonly Measured[], allowed: readonly string[]): TargetCheck {
  const problems: string[] = [];
  const blocked: string[] = [];
  measured.forEach((item, me) => {
    const inside = item.grid.filter((point) => signedDistance(item.shape, point.x, point.y) <= INSIDE);
    const stolen = inside.filter((point) => point.owner !== me);
    const first = stolen[0];
    if (inside.length === 0) problems.push(`${item.name}: видимой формы в окне нет`);
    if (first !== undefined) {
      const thief = first.owner >= 0 ? (measured[first.owner]?.name ?? String(first.owner)) : 'не элемент управления';
      problems.push(`${item.name}: видимую часть забрал другой — ${String(stolen.length)} из ${String(inside.length)} точек, первая ${first.x.toFixed(1)},${first.y.toFixed(1)}: ${thief}`);
    }
    const result: Verdict = verdict(item.map, me, item.neighbours, SIDE).verdict;
    if (result === 'square') return;
    if (result === 'blocked' && allowed.some((prefix) => item.name.startsWith(prefix))) blocked.push(item.name);
    else problems.push(`${item.name}: ${result}${where(measured, item, me)}`);
  });
  return { count: measured.length, problems, blocked };
}

/** Для small — первая свободная точка не у элемента и чья она: где искать. */
function where(measured: readonly Measured[], item: Measured, me: number): string {
  const free = verdict(item.map, me, item.neighbours, SIDE).free;
  if (free === null) return '';
  const owner = free.owner >= 0 ? (measured[free.owner]?.name ?? String(free.owner)) : free.owner === -2 ? 'вне окна' : 'ничей';
  return ` — точка ${free.x.toFixed(1)},${free.y.toFixed(1)}: ${owner}`;
}

/** Элемент в фокусе: форма, рамка (вычисленный outline), где снимать и что из этого видно. */
interface Focused {
  readonly name: string;
  readonly type: string;
  /** Рамка самого поля, когда она у строки выбора: обязана быть none. */
  readonly inner: string;
  readonly shape: Shape;
  readonly style: string;
  readonly offset: number;
  readonly width: number;
  readonly clip: Rect;
  readonly visible: Rect;
}

/**
 * Элемент в фокусе — докрученный в видимую часть своих прокруток: WebKit докручивает сам, но уже после фокуса. Рамка
 * радио и флажка — у строки выбора (label.choice): у самого поля браузер сбрасывает скругление, его рамка была бы
 * квадратом вокруг круга; inner — outline самого поля, он обязан быть none.
 */
function focused(page: Page): Promise<Focused | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) return null;
    active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const choice = active instanceof HTMLInputElement && (active.type === 'radio' || active.type === 'checkbox') ? active.closest('label.choice') : null;
    const element = choice ?? active;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const radius = (value: string): number => {
      const [horizontal = '0', vertical = horizontal] = value.split(' ');
      const px = (token: string, base: number): number => (token.endsWith('%') ? (Number.parseFloat(token) / 100) * base : Number.parseFloat(token) || 0);
      return Math.min(px(horizontal, rect.width), px(vertical, rect.height));
    };
    const offset = Number.parseFloat(style.outlineOffset);
    const width = Number.parseFloat(style.outlineWidth);
    const margin = Math.max(0, offset) + width + 6;
    const left = Math.max(0, Math.floor(rect.left - margin));
    const top = Math.max(0, Math.floor(rect.top - margin));
    const right = Math.min(window.innerWidth, Math.ceil(rect.right + margin));
    const bottom = Math.min(window.innerHeight, Math.ceil(rect.bottom + margin));
    // Видно — окно и внутренность каждого предка с прокруткой или обрезкой: рамку за его краем не видно.
    let visible = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      const overflow = getComputedStyle(node);
      if (overflow.overflowX === 'visible' && overflow.overflowY === 'visible') continue;
      const box = node.getBoundingClientRect();
      const x = Math.max(visible.x, box.x + node.clientLeft);
      const y = Math.max(visible.y, box.y + node.clientTop);
      const x2 = Math.min(visible.x + visible.width, box.x + node.clientLeft + node.clientWidth);
      const y2 = Math.min(visible.y + visible.height, box.y + node.clientTop + node.clientHeight);
      visible = { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
    }
    const label = element instanceof HTMLInputElement ? (element.labels?.[0]?.textContent ?? '') : '';
    return {
      name: `${element.tagName}:${(element.getAttribute('aria-label') ?? (label || element.textContent)).replace(/\s+/g, ' ').trim().slice(0, 30)}`,
      type: active instanceof HTMLInputElement ? active.type : active.tagName.toLowerCase(),
      inner: choice === null ? 'none' : getComputedStyle(active).outlineStyle,
      shape: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        radii: [radius(style.borderTopLeftRadius), radius(style.borderTopRightRadius), radius(style.borderBottomRightRadius), radius(style.borderBottomLeftRadius)],
      },
      style: style.outlineStyle,
      offset,
      width,
      clip: { x: left, y: top, width: right - left, height: bottom - top },
      visible,
    };
  });
}

/** Рамка элемента в фокусе: вычисленный outline и снимки с ней и без неё (отметка ввода pointer её снимает). */
export interface FocusRing {
  readonly name: string;
  /** Тип поля ввода или имя тега. */
  readonly type: string;
  readonly style: string;
  readonly width: number;
  /** Рамка самого радио или флажка, когда рамка — у строки выбора; иначе none. */
  readonly inner: string;
  readonly report: RingReport;
}

const sameRect = (a: Rect, b: Rect): boolean => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01;

export async function focusRing(page: Page): Promise<FocusRing | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const item = await focused(page);
    if (item === null) return null;
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const on = decodePng(await page.screenshot({ clip: item.clip }));
    await page.evaluate(() => {
      document.documentElement.dataset['input'] = 'pointer';
    });
    const off = decodePng(await page.screenshot({ clip: item.clip }));
    await page.evaluate(() => {
      document.documentElement.dataset['input'] = 'keyboard';
    });
    // Элемент сдвинулся между снимками (прокрутка ещё шла) — снимки не сравнить, снять заново.
    const after = await focused(page);
    if (after === null || !sameRect(item.shape, after.shape)) continue;
    const report = ringReport(item.shape, { offset: item.offset, width: item.width }, item.clip, dpr, on, off, item.visible);
    return { name: item.name, type: item.type, style: item.style, width: item.width, inner: item.inner, report };
  }
  throw new Error('элемент в фокусе не стоит на месте: снимки с рамкой и без не сравнить');
}

interface Look {
  readonly filter: string;
  readonly transform: string;
  /** Кадров, в которые кнопка была :active: жест дошёл до страницы. */
  readonly frames: number;
}

/**
 * Вид нажатой кнопки пишет сама страница: каждый кадр, пока кнопка :active, — фильтр и трансформ (опрос извне по CDP
 * окно долгого касания пропускает: оно снимает :active через полсекунды). Итог — последний кадр нажатия.
 */
async function watchPressed(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    const frames: { filter: string; transform: string }[] = [];
    (window as unknown as { pressedFrames: typeof frames }).pressedFrames = frames;
    const until = performance.now() + 5000;
    const tick = (): void => {
      if (element.matches(':active')) {
        const style = getComputedStyle(element);
        frames.push({ filter: style.filter, transform: style.transform });
      }
      if (performance.now() < until) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Долгое касание жестом браузера Chromium (Input.synthesizeTapGesture, 1.5 с): путь пальца — :active и долгое нажатие.
 * Возвращает вид нажатой кнопки и выделение после жеста.
 */
export async function touchHold(cdp: CDPSession, target: Locator): Promise<Look & { readonly selection: string }> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('нет кнопки');
  await watchPressed(target);
  await cdp.send('Input.synthesizeTapGesture', { x: box.x + box.width / 2, y: box.y + box.height / 2, duration: 1500, tapCount: 1, gestureSourceType: 'touch' });
  const selection = await target.page().evaluate(() => window.getSelection()?.toString() ?? '');
  const frames = await target.evaluate(() => (window as unknown as { pressedFrames: { filter: string; transform: string }[] }).pressedFrames);
  const last = frames.at(-1);
  return { filter: last?.filter ?? 'не нажата', transform: last?.transform ?? 'не нажата', frames: frames.length, selection };
}
