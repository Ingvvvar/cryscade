// Свет огранки §9: ключевой сверху слева, заполняющий справа, бирюзовый контровой снизу.
// Грань заливается плоско по Ламберту: цвет = альбедо × (фон + Σ интенсивность · max(0, n·L)) + контровой,
// плюс белый блеск ключевого по Блинну — Фонгу, тоже на всю грань: насыщенный цвет (Рубин, Сапфир) упирается
// в свой канал, и без блеска верх камня не светлее низа.
// Нормали — фиктивные, с наклоном наружу; направления — к источнику, ось y вниз, z — к зрителю.

import { linear, pack } from './color.ts';
import { dot3, unit3, type Vec3 } from './geometry.ts';
import { PALETTE } from './palette.ts';

export interface Light {
  readonly direction: Vec3;
  readonly intensity: number;
  readonly color: number;
}

export const LIGHTING = {
  ambient: 0.18,
  key: { direction: unit3(-0.55, -0.65, 0.52), intensity: 1.05, color: 0xffffff },
  fill: { direction: unit3(0.75, 0.1, 0.65), intensity: 0.3, color: 0xdfe6ff },
  /** Кристалл подсвечен снизу бирюзой из ядра под сеткой. Камень просвечивает: контровой идёт наполовину
   *  через его цвет (RIM_THROUGH), наполовину поверх. Свет скользящий — почти в плоскости экрана:
   *  ловят его нижние грани, площадку он почти не трогает. */
  rim: { direction: unit3(0, 1, 0.1), intensity: 0.35, color: PALETTE.glow },
} as const satisfies { ambient: number; key: Light; fill: Light; rim: Light };

/** Доля контрового, окрашенная цветом кристалла. */
const RIM_THROUGH = 0.65;
/** Блеск ключевого: сила и острота; половинный вектор — между светом и взглядом (0, 0, 1). */
const SHEEN = { strength: 0.35, power: 8 } as const;
const HALF = unit3(LIGHTING.key.direction.x, LIGHTING.key.direction.y, LIGHTING.key.direction.z + 1);

export function shade(albedo: number, normal: Vec3): number {
  const a = linear(albedo);
  const key = linear(LIGHTING.key.color);
  const fill = linear(LIGHTING.fill.color);
  const rim = linear(LIGHTING.rim.color);
  const k = LIGHTING.key.intensity * Math.max(0, dot3(normal, LIGHTING.key.direction));
  const f = LIGHTING.fill.intensity * Math.max(0, dot3(normal, LIGHTING.fill.direction));
  const r = LIGHTING.rim.intensity * Math.max(0, dot3(normal, LIGHTING.rim.direction));
  const ambient = LIGHTING.ambient;
  const sheen = SHEEN.strength * Math.max(0, dot3(normal, HALF)) ** SHEEN.power;
  const through = (channel: number): number => 1 - RIM_THROUGH + RIM_THROUGH * channel;
  return pack({
    r: a.r * (ambient + k * key.r + f * fill.r) + r * rim.r * through(a.r) + sheen,
    g: a.g * (ambient + k * key.g + f * fill.g) + r * rim.g * through(a.g) + sheen,
    b: a.b * (ambient + k * key.b + f * fill.b) + r * rim.b * through(a.b) + sheen,
  });
}
