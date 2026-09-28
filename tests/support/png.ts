// PNG без зависимостей — node:zlib. Декодер: 8 бит на канал, RGB и RGBA, без чересстрочности, все пять фильтров,
// CRC каждого блока проверяется. Кодировщик: RGBA, фильтр None — для атласа в сером (снимки фазы 3).
// Эталон декодера — PNG из sips (tests/reference/png), см. tests/unit/support/png.test.ts.

import { crc32, deflateSync, inflateSync } from 'node:zlib';

export interface Image {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 байта на пиксель, строки сверху вниз. */
  readonly rgba: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(data: Uint8Array): Image {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('не PNG: сигнатура');
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let pos = 8; pos < buffer.length; ) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('latin1', pos + 4, pos + 8);
    const body = buffer.subarray(pos + 8, pos + 8 + length);
    if (crc32(buffer.subarray(pos + 4, pos + 8 + length)) !== buffer.readUInt32BE(pos + 8 + length)) {
      throw new Error(`PNG: CRC блока ${type} не сходится`);
    }
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0) throw new Error('PNG: только 8 бит без чересстрочности');
      if (colour === 2) channels = 3;
      else if (colour === 6) channels = 4;
      else throw new Error(`PNG: тип цвета ${String(colour)} не поддерживается`);
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new Error('PNG: размер данных не сходится');
  const rgba = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const offset = y * (stride + 1);
    const filter = raw[offset];
    for (let i = 0; i < stride; i++) {
      const x = raw[offset + 1 + i] ?? 0;
      const a = i >= channels ? (line[i - channels] ?? 0) : 0;
      const b = previous[i] ?? 0;
      const c = i >= channels ? (previous[i - channels] ?? 0) : 0;
      let value: number;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else if (filter === 4) value = x + paeth(a, b, c);
      else throw new Error(`PNG: фильтр ${String(filter)} в строке ${String(y)}`);
      line[i] = value & 0xff;
    }
    for (let px = 0; px < width; px++) {
      const out = (y * width + px) * 4;
      const src = px * channels;
      rgba[out] = line[src] ?? 0;
      rgba[out + 1] = line[src + 1] ?? 0;
      rgba[out + 2] = line[src + 2] ?? 0;
      rgba[out + 3] = channels === 4 ? (line[src + 3] ?? 0) : 255;
    }
    previous.set(line);
  }
  return { width, height, rgba };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

export function encodePng(image: Image): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = image.width * 4;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++) raw.set(image.rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

/** Относительная яркость WCAG 2.2 из sRGB-байтов. */
export function luminance(r: number, g: number, b: number): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Контраст WCAG: (светлее + 0.05) / (темнее + 0.05). */
export function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
