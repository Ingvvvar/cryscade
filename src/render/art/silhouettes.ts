// Силуэты символов §4.1 — многоугольники в единицах радиуса: центр рамки в (0, 0), всё внутри [−1, 1].
// Различаются без цвета: попарное IoU масок меньше 0.8 и как нарисованы, и при общем масштабе (§9, тест силуэтов).
// Формы подобраны перебором под это требование:
// - Бриллиант — профиль круглой огранки (площадка, рундист, остриё). Круг сверху давал с квадратом Аметиста
//   IoU 0.82 при общем масштабе: у квадрата и вписанного круга оно около π/4 по самой геометрии;
// - квадрат Аметиста меньше рамки — он зрительно тяжелее прочих и иначе слишком близок к пятиугольнику.

import { SYMBOL, type SymbolId } from '../../core/model/symbols.ts';
import { centreBounds, chamfer, polar, regular, type Point } from './geometry.ts';

const TAU = 2 * Math.PI;

function drop(radius: number, centreY: number, tipY: number, arcPoints: number): Point[] {
  // Касательные из острия к окружности: угол между вертикалью и радиусом в точку касания.
  const phi = Math.acos(radius / (centreY - tipY));
  const out: Point[] = [{ x: 0, y: tipY }];
  for (let i = 0; i <= arcPoints; i++) out.push(polar(radius, phi + (i * (TAU - 2 * phi)) / arcPoints, 0, centreY));
  return out;
}

function heart(widthScale: number, samples: number): Point[] {
  // Классическая кривая сердца: x = 16 sin³t, y = 13 cos t − 5 cos 2t − 2 cos 3t − cos 4t (ось y — вниз).
  return Array.from({ length: samples }, (_, i) => {
    const t = (i * TAU) / samples;
    const x = 16 * Math.sin(t) ** 3;
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    return { x: (x / 17) * widthScale, y: y / 17 };
  });
}

function rayedSphere(bodyRadius: number, longRay: number, shortRay: number, halfAngle: number): Point[] {
  const out: Point[] = [];
  for (let k = 0; k < 8; k++) {
    const angle = (k * TAU) / 8;
    out.push(
      polar(bodyRadius, angle - halfAngle),
      polar(k % 2 === 0 ? longRay : shortRay, angle),
      polar(bodyRadius, angle + halfAngle),
      polar(bodyRadius, angle + TAU / 16),
    );
  }
  return out;
}

export const SILHOUETTES: Readonly<Record<SymbolId, readonly Point[]>> = {
  [SYMBOL.quartz]: centreBounds(chamfer([{ x: 0, y: -0.97 }, { x: 0.93, y: 0.66 }, { x: -0.93, y: 0.66 }], 0.13)),
  [SYMBOL.amethyst]: centreBounds(chamfer(regular(4, 0.7 * Math.SQRT2, TAU / 8), 0.1)),
  [SYMBOL.citrine]: centreBounds(regular(5, 0.95)),
  [SYMBOL.emerald]: centreBounds(
    chamfer(
      [
        { x: -0.6, y: -0.95 },
        { x: 0.6, y: -0.95 },
        { x: 0.6, y: 0.95 },
        { x: -0.6, y: 0.95 },
      ],
      0.26,
    ),
  ),
  [SYMBOL.sapphire]: centreBounds(drop(0.6, 0.34, -0.97, 14)),
  [SYMBOL.ruby]: centreBounds(heart(1.03, 24)),
  [SYMBOL.diamond]: centreBounds([
    { x: -0.45, y: -0.66 },
    { x: 0.45, y: -0.66 },
    { x: 0.97, y: -0.5 },
    { x: 0, y: 0.97 },
    { x: -0.97, y: -0.5 },
  ]),
  [SYMBOL.core]: centreBounds(rayedSphere(0.56, 0.98, 0.8, 0.2)),
};
