import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contrast, decodePng, encodePng, luminance } from '../../support/png.ts';

// Эталон — PNG, записанные sips (macOS ImageIO, sips-316) один раз из TGA 16×8, собранных побайтно по формулам ниже:
//   sips -s format png rgb.tga --out tests/reference/png/rgb.png
//   sips -s format png rgba.tga --out tests/reference/png/rgba.png
// TGA: без сжатия, начало сверху слева; RGB — 24 бита, RGBA — 32 бита. Полупрозрачный пиксель (255, 0, 255, 128)
// переживает премультипликацию ImageIO без округления, прозрачный — (0, 0, 0, 0). sips берёт фильтры None, Sub и Paeth;
// Up и Average проверяются на PNG 2×2, собранных ниже побайтно.

const REFERENCE = new URL('../../reference/png/', import.meta.url);
const SHA256 = {
  'rgb.png': '6263442755ed7247fe4e813382ac7e3645a489277f7db3bffd126f3fd29d3d37',
  'rgba.png': '3a54b3ea253f9bd41c88baf31974996d30f9045902684333ac065a46bcc1c392',
} as const;

const rgb = (x: number, y: number): [number, number, number] => [(x * 17) & 255, (y * 31) & 255, (x * y * 7 + 13) & 255];
function rgba(x: number, y: number): [number, number, number, number] {
  const k = (x + y) % 3;
  if (k === 0) return [0, 0, 0, 0];
  if (k === 1) return [...rgb(x, y), 255];
  return [255, 0, 255, 128];
}

function read(name: keyof typeof SHA256): Buffer {
  const data = readFileSync(new URL(name, REFERENCE));
  expect(createHash('sha256').update(data).digest('hex'), `${name}: эталон изменился`).toBe(SHA256[name]);
  return data;
}

function pixel(image: { width: number; rgba: Uint8Array }, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return [...image.rgba.subarray(i, i + 4)];
}

function png(width: number, height: number, colour: 2 | 6, raw: number[]): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, colour, 0, 0, 0], 8);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]);
}

describe('decodePng на эталонах sips', () => {
  it('RGB 16×8: каждый пиксель — по формуле, альфа 255', () => {
    const image = decodePng(read('rgb.png'));
    expect([image.width, image.height]).toStrictEqual([16, 8]);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) expect(pixel(image, x, y), `${String(x)},${String(y)}`).toStrictEqual([...rgb(x, y), 255]);
  });

  it('RGBA 16×8: каждый пиксель — по формуле, включая прозрачные и полупрозрачные', () => {
    const image = decodePng(read('rgba.png'));
    for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) expect(pixel(image, x, y), `${String(x)},${String(y)}`).toStrictEqual(rgba(x, y));
  });
});

describe('decodePng: фильтры Up и Average — PNG 2×2 побайтно', () => {
  it('Up: вторая строка — дельты к верхней', () => {
    // Строка 0 без фильтра: (10,20,30) (40,50,60). Строка 1, Up: (1,2,3) (4,5,6) → (11,22,33) (44,55,66).
    const image = decodePng(png(2, 2, 2, [0, 10, 20, 30, 40, 50, 60, 2, 1, 2, 3, 4, 5, 6]));
    expect([pixel(image, 0, 1), pixel(image, 1, 1)]).toStrictEqual([
      [11, 22, 33, 255],
      [44, 55, 66, 255],
    ]);
  });

  it('Average: дельта к полусумме левого и верхнего, с округлением вниз', () => {
    // Строка 0: (5,10,15) (40,50,60). Строка 1, Average: (1,1,1) (2,2,2).
    // Пиксель 0: слева 0, сверху (5,10,15) → 1 + ⌊5/2⌋ = 3, 1 + 5 = 6, 1 + ⌊15/2⌋ = 8.
    // Пиксель 1: слева (3,6,8), сверху (40,50,60) → 2 + ⌊43/2⌋ = 23, 2 + ⌊56/2⌋ = 30, 2 + ⌊68/2⌋ = 36.
    const image = decodePng(png(2, 2, 2, [0, 5, 10, 15, 40, 50, 60, 3, 1, 1, 1, 2, 2, 2]));
    expect([pixel(image, 0, 1), pixel(image, 1, 1)]).toStrictEqual([
      [3, 6, 8, 255],
      [23, 30, 36, 255],
    ]);
  });
});

describe('decodePng: Paeth при равенстве оценок', () => {
  it('pb = pc — берётся верхний, а не диагональный (порядок из спецификации PNG)', () => {
    // Строка 0: (2,2,2) (6,6,6). Строка 1, Paeth: (254,254,254) (1,1,1).
    // Пиксель 0: слева 0, сверху 2, по диагонали 0 → p = 2, ближе всех верхний → (254 + 2) mod 256 = 0.
    // Пиксель 1: слева 0, сверху 6, по диагонали 2 → p = 4; pa = 4, pb = 2, pc = 2 — ничья b и c, берётся b → 1 + 6 = 7.
    const image = decodePng(png(2, 2, 2, [0, 2, 2, 2, 6, 6, 6, 4, 254, 254, 254, 1, 1, 1]));
    expect([pixel(image, 0, 1), pixel(image, 1, 1)]).toStrictEqual([
      [0, 0, 0, 255],
      [7, 7, 7, 255],
    ]);
  });
});

describe('decodePng: испорченное — ошибка', () => {
  it('не та сигнатура, битый CRC, 16 бит на канал', () => {
    expect(() => decodePng(Buffer.from('not a png at all'))).toThrow(/сигнатура/);
    const good = png(1, 1, 2, [0, 1, 2, 3]);
    const broken = Buffer.from(good);
    const at = broken.length - 20;
    broken.writeUInt8(broken.readUInt8(at) ^ 0xff, at);
    expect(() => decodePng(broken)).toThrow(/CRC/);
    const deep = png(1, 1, 2, [0, 1, 2, 3]);
    deep[8 + 8 + 8] = 16;
    deep.writeUInt32BE(crc32(deep.subarray(12, 12 + 4 + 13)), 12 + 4 + 13);
    expect(() => decodePng(deep)).toThrow(/8 бит/);
  });
});

describe('encodePng', () => {
  it('туда и обратно — те же пиксели', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 1, max: 9 }), fc.uint8Array({ minLength: 324, maxLength: 324 }), (w, h, bytes) => {
        const image = { width: w, height: h, rgba: bytes.subarray(0, w * h * 4) };
        const back = decodePng(encodePng(image));
        return back.width === w && back.height === h && Buffer.from(back.rgba).equals(Buffer.from(image.rgba));
      }),
    );
  });
});

describe('яркость и контраст WCAG', () => {
  it('белый и чёрный — 21:1; #777 на белом — 4.48:1 (известное значение WCAG)', () => {
    expect(luminance(255, 255, 255)).toBeCloseTo(1, 12);
    expect(luminance(0, 0, 0)).toBe(0);
    expect(contrast(luminance(255, 255, 255), luminance(0, 0, 0))).toBeCloseTo(21, 12);
    expect(contrast(luminance(0x77, 0x77, 0x77), 1)).toBeCloseTo(4.48, 2);
  });

  it('контраст симметричен', () => {
    expect(contrast(0.2, 0.05)).toBe(contrast(0.05, 0.2));
  });
});
