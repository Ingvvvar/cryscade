// Стабильный кадр (§15, фаза 3): поддельные часы Playwright, сетка упала, время декора закреплено.
// Кадр — настоящий: снимок страницы, как её собрал браузер, а не выгрузка текстуры.

import { expect, type Page } from '@playwright/test';
import type { Insets } from '../../../src/render/layout.ts';
import { decodePng, type Image } from '../../support/png.ts';
import { sceneInfo, waitSettled, type ProbeWindow } from '../../support/page-probe.ts';
import type { ProbeSceneInfo } from '../../../src/ui/probe-api.ts';

/** Момент декора для снимков: блик рамки на верхней грани, каустики и пыль — не в нуле. */
export const PINNED_AMBIENT_S = 1.2;

/** Вырезы телефона — через вычисленные поля элемента, из которого приложение читает env(safe-area-inset-*). */
export async function fakeSafeArea(page: Page, insets: Insets): Promise<void> {
  const css = `.safe-area-probe { padding: ${String(insets.top)}px ${String(insets.right)}px ${String(insets.bottom)}px ${String(insets.left)}px !important; }`;
  await page.addInitScript((text) => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = text;
      document.head.append(style);
    });
  }, css);
}

/** Загрузка на поддельных часах; после падения сетки время страницы стоит, декор закреплён. */
export async function openStill(page: Page, query: string): Promise<ProbeSceneInfo> {
  await page.clock.install({ time: 0 });
  await page.goto(`./${query}`);
  await waitSettled(page);
  await page.clock.pauseAt(60_000);
  await page.evaluate((seconds) => {
    (window as ProbeWindow).__cryscadeProbe?.pinAmbient(seconds);
  }, PINNED_AMBIENT_S);
  await page.clock.runFor(100);
  return sceneInfo(page);
}

export async function snapshot(page: Page): Promise<{ png: Buffer; image: Image }> {
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  return { png, image: decodePng(png) };
}

export interface Difference {
  /** Средняя и наибольшая разница каналов RGB, в долях 255. */
  readonly mean: number;
  readonly max: number;
  /** Сколько пикселей различается и в какой рамке [x0, y0, x1, y1], пиксели устройства. */
  readonly pixels: number;
  readonly box: readonly number[];
}

export function difference(a: Image, b: Image): Difference {
  expect([a.width, a.height]).toStrictEqual([b.width, b.height]);
  let sum = 0;
  let max = 0;
  let pixels = 0;
  const box = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, -1, -1];
  for (let i = 0; i < a.rgba.length; i += 4) {
    let local = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs((a.rgba[i + c] ?? 0) - (b.rgba[i + c] ?? 0));
      sum += d;
      local = Math.max(local, d);
    }
    if (local === 0) continue;
    max = Math.max(max, local);
    pixels += 1;
    const x = (i / 4) % a.width;
    const y = Math.floor(i / 4 / a.width);
    box[0] = Math.min(box[0] ?? x, x);
    box[1] = Math.min(box[1] ?? y, y);
    box[2] = Math.max(box[2] ?? x, x);
    box[3] = Math.max(box[3] ?? y, y);
  }
  return { mean: sum / (3 * a.width * a.height) / 255, max: max / 255, pixels, box: pixels === 0 ? [] : box };
}
