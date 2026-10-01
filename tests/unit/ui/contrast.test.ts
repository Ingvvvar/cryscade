import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Контраст AA (§11, решение 7 фазы 7) по парам токенов, которые реально задаёт styles.css: цвет и фон одного правила;
// цвет правила без своего фона — на фонах контейнеров (правила с фоном без цвета) и страницы. Полупрозрачный rgb() фона —
// по токену с теми же каналами. Градиент статически не меряется: «Спін» на своём градиенте меряет e2e по пикселям
// (tests/e2e/shell.spec.ts). Неактивные кнопки (opacity) WCAG из требования исключает.

const CSS = readFileSync('src/ui/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const AA = 4.5;

/** Относительная яркость WCAG 2.x по #rrggbb. */
function luminance(hex: string): number {
  const channel = (at: number): number => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const hexOf = (r: number, g: number, b: number): string => `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;

const TOKENS = new Map(
  [...(/:root\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '').matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [match[1] ?? '', (match[2] ?? '').toLowerCase()] as const),
);

/** Токен фона: var(--x) или rgb(r g b / a) с каналами токена; градиент, transparent — null. */
function backgroundToken(value: string): string | null {
  const token = /^var\(--([\w-]+)\)$/.exec(value)?.[1];
  if (token !== undefined) return token;
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ [\d.]+)?\)$/.exec(value);
  if (rgb === null) return null;
  const hex = hexOf(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  return [...TOKENS].find(([, value2]) => value2 === hex)?.[0] ?? null;
}

interface Rule {
  readonly selector: string;
  readonly color: string | null;
  readonly background: string | null;
}

const RULES: readonly Rule[] = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => {
  const body = match[2] ?? '';
  const color = /(?:^|[\s;])color:\s*var\(--([\w-]+)\)/.exec(body)?.[1] ?? null;
  const background = /(?:^|[\s;])background(?:-color)?:\s*([^;!]+?)\s*(?:!important)?\s*;/.exec(body)?.[1];
  return { selector: (match[1] ?? '').trim(), color, background: background === undefined ? null : backgroundToken(background) };
});

interface Pair {
  readonly color: string;
  readonly background: string;
  readonly where: string;
}

function pairs(): Pair[] {
  const page = RULES.find((rule) => rule.selector.includes('body'))?.background ?? null;
  const containers = new Set(RULES.filter((rule) => rule.color === null && rule.background !== null).map((rule) => rule.background ?? ''));
  if (page !== null) containers.add(page);
  const out: Pair[] = [];
  for (const rule of RULES) {
    if (rule.color === null) continue;
    if (rule.background !== null) out.push({ color: rule.color, background: rule.background, where: rule.selector });
    else for (const background of containers) out.push({ color: rule.color, background, where: `${rule.selector} на фоне контейнера` });
  }
  return out;
}

describe('контраст AA', () => {
  it('формула WCAG — на независимо посчитанных литералах', () => {
    expect(contrast('#eef3ff', '#050814')).toBeCloseTo(17.98, 2);
    expect(contrast('#8a97c4', '#13204a')).toBeCloseTo(5.48, 2);
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 6);
  });

  it('токены палитры прочитаны, правила с цветом и с фоном найдены', () => {
    expect(TOKENS.size).toBeGreaterThanOrEqual(8);
    expect(RULES.filter((rule) => rule.color !== null).length).toBeGreaterThan(5);
    expect(RULES.filter((rule) => rule.background !== null).length).toBeGreaterThan(5);
  });

  it('каждая пара «текст — фон» из styles.css — не меньше 4.5:1', () => {
    const found = pairs();
    expect(found.length).toBeGreaterThan(10);
    const unknown = found.filter((pair) => !TOKENS.has(pair.color) || !TOKENS.has(pair.background));
    expect(unknown).toStrictEqual([]);
    const weak = found
      .map((pair) => ({ ...pair, ratio: contrast(TOKENS.get(pair.color) ?? '', TOKENS.get(pair.background) ?? '') }))
      .filter((pair) => pair.ratio < AA)
      .map((pair) => `${pair.where}: --${pair.color} на --${pair.background} — ${pair.ratio.toFixed(2)}`);
    expect(weak).toStrictEqual([]);
  });

  it('пары, которые точно есть: текст на странице, подпись на диалоге, тёмный текст выбранной ставки на свечении и включённого «Турбо» на тёплом', () => {
    const found = pairs().map((pair) => `${pair.color}/${pair.background}`);
    expect(found).toEqual(expect.arrayContaining(['text/cave-0', 'muted/cave-1', 'cave-0/glow', 'glow/cave-1', 'cave-0/warm']));
    expect(RULES.find((rule) => rule.selector === ".panel .toggle[aria-pressed='true']")).toStrictEqual({
      selector: ".panel .toggle[aria-pressed='true']",
      color: 'cave-0',
      background: 'warm',
    });
  });
});
