// Цвет арта: упакованный 0xRRGGBB в sRGB; свет считается в линейном пространстве.

interface Linear {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toSrgb(value: number): number {
  const v = Math.min(1, Math.max(0, value));
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(c * 255);
}

export function linear(color: number): Linear {
  return { r: toLinear((color >> 16) & 0xff), g: toLinear((color >> 8) & 0xff), b: toLinear(color & 0xff) };
}

/** Обратно в 0xRRGGBB; каналы за пределами [0, 1] обрезаются. */
export function pack(color: Linear): number {
  return (toSrgb(color.r) << 16) | (toSrgb(color.g) << 8) | toSrgb(color.b);
}

/** Смесь в линейном пространстве: share — доля b. */
export function mix(a: number, b: number, share: number): number {
  const x = linear(a);
  const y = linear(b);
  return pack({ r: x.r + (y.r - x.r) * share, g: x.g + (y.g - x.g) * share, b: x.b + (y.b - x.b) * share });
}

/** Яркость в линейном пространстве: множитель на все каналы. */
export function brighten(color: number, factor: number): number {
  const c = linear(color);
  return pack({ r: c.r * factor, g: c.g * factor, b: c.b * factor });
}
