import { describe, expect, it } from 'vitest';
import { LIGHTING, shade } from '../../../src/render/art/light.ts';

// Свет огранки §9 — свойства, а не та же формула: грань к ключевому свету ярче противоположной,
// бирюзовый контровой приходит снизу, выход — корректный цвет.

const channels = (color: number): [number, number, number] => [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
const sum = (color: number): number => channels(color).reduce((a, b) => a + b, 0);

function tilted(dx: number, dy: number, tilt: number): { x: number; y: number; z: number } {
  const length = Math.hypot(dx, dy);
  return { x: (dx / length) * Math.sin(tilt), y: (dy / length) * Math.sin(tilt), z: Math.cos(tilt) };
}

describe('shade', () => {
  const GREY = 0x808080;

  it('грань к ключевому свету (вверх-влево) ярче грани, повёрнутой от него', () => {
    const towardKey = tilted(LIGHTING.key.direction.x, LIGHTING.key.direction.y, 0.7);
    const away = tilted(-LIGHTING.key.direction.x, -LIGHTING.key.direction.y, 0.7);
    expect(sum(shade(GREY, towardKey))).toBeGreaterThan(sum(shade(GREY, away)) + 30);
  });

  it('насыщенный цвет тоже светлеет к ключевому свету: блеск белый, а не через альбедо', () => {
    const RUBY = 0xff2e63;
    const towardKey = tilted(LIGHTING.key.direction.x, LIGHTING.key.direction.y, 0.7);
    const away = tilted(-LIGHTING.key.direction.x, -LIGHTING.key.direction.y, 0.7);
    const [, gToward] = channels(shade(RUBY, towardKey));
    const [, gAway] = channels(shade(RUBY, away));
    expect(gToward).toBeGreaterThan(gAway);
    expect(sum(shade(RUBY, towardKey))).toBeGreaterThan(sum(shade(RUBY, away)) + 30);
  });

  it('контровой снизу бирюзовый: у нижней грани зелёный и синий растут сильнее красного', () => {
    const down = channels(shade(GREY, tilted(0, 1, 0.8)));
    const up = channels(shade(GREY, tilted(0, -1, 0.8)));
    const tint = ([r, g, b]: [number, number, number]): number => (g + b) / 2 - r;
    expect(tint(down)).toBeGreaterThan(tint(up) + 20);
  });

  it('площадку контровой почти не трогает: бирюзы у неё меньше, чем у нижней грани', () => {
    const tint = ([r, g, b]: [number, number, number]): number => (g + b) / 2 - r;
    expect(tint(channels(shade(GREY, { x: 0, y: 0, z: 1 })))).toBeLessThan(tint(channels(shade(GREY, tilted(0, 1, 0.8)))) - 20);
  });

  it('у чёрного кристалла сверху остаётся только белый блеск — серый без оттенка', () => {
    const [r, g, b] = channels(shade(0x000000, tilted(0, -1, 0.8)));
    expect(r).toBeGreaterThan(0);
    expect([g, b]).toStrictEqual([r, r]);
  });

  it('выход — целый 0xRRGGBB при любых нормалях и альбедо', () => {
    for (const albedo of [0x000000, 0xffffff, 0x2f6bff, 0xff2e63]) {
      for (let angle = 0; angle < 2 * Math.PI; angle += Math.PI / 8) {
        const color = shade(albedo, tilted(Math.cos(angle), Math.sin(angle), 0.8));
        expect(Number.isInteger(color)).toBe(true);
        expect(color).toBeGreaterThanOrEqual(0);
        expect(color).toBeLessThanOrEqual(0xffffff);
      }
    }
  });
});
