// Общий атлас §9: выпекается один раз в RenderTexture по плану art/atlas-plan.ts; все кадры — одна базовая
// текстура, один батч. Разрешение текстуры — ATLAS_RESOLUTION, кадры — в единицах дизайна: спрайт из атласа
// сразу нужного размера. Градиенты — полосами и стопками кругов из art/, без FillGradient: текстуры градиента,
// побывав в батче WebGPU, нельзя уничтожить без предупреждения (модульный кэш групп привязок Pixi 8.21).
// Свечение — тоже без фильтра: стопка расширенных полупрозрачных силуэтов. BlurFilter на выпечке оставлял после
// себя текстуры пула и буферы униформ в группах привязок, и перемонтирование рендерера сыпало предупреждениями
// «destroyed while still bound» (найдено e2e перемонтирования живой сцены).

import { Container, Graphics, Rectangle, RenderTexture, Texture, type Renderer } from 'pixi.js';
import { SYMBOL_COUNT, type SymbolId } from '../../core/model/symbols.ts';
import {
  CHIP,
  PANEL_BORDER,
  atlasEntries,
  glowKey,
  planAtlas,
  shardKey,
  symbolKey,
  type AtlasKey,
  type AtlasPlan,
  type ShardIndex,
} from '../art/atlas-plan.ts';
import { mix } from '../art/color.ts';
import { OUTLINE, SHARDS_PER_SYMBOL, symbolArt, type Band, type CoreArt, type CrystalArt, type Segment, type SymbolArt } from '../art/crystal.ts';
import { type Point } from '../art/geometry.ts';
import { shade } from '../art/light.ts';
import { DISPERSION, PALETTE } from '../art/palette.ts';
import { CELL, FRAME_BORDER } from '../layout.ts';

/** Скругление подложки клетки и её отступ внутри клетки, единицы дизайна. */
const BACKING_INSET = 3;
const BACKING_RADIUS = 10;

function drawBands(g: Graphics, bands: readonly Band[]): void {
  for (const band of bands) g.poly([...band.points]).fill(band.color);
}

/** Блик-звезда: четыре длинных луча и мягкая середина. */
function drawStar(g: Graphics, x: number, y: number, size: number, alpha = 0.95): void {
  const points: Point[] = [];
  for (let k = 0; k < 8; k++) {
    const angle = (k * Math.PI) / 4;
    const radius = k % 2 === 0 ? size : size * 0.2;
    points.push({ x: x + radius * Math.sin(angle), y: y - radius * Math.cos(angle) });
  }
  g.poly(points).fill({ color: 0xffffff, alpha });
  g.circle(x, y, size * 0.28).fill({ color: 0xffffff, alpha });
}

/** Светлая кромка — чуть внутри силуэта, чтобы тёмная обводка её не съела. */
function drawRim(g: Graphics, rim: readonly Segment[], color: number): void {
  for (const { from, to } of rim) {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const ix = (-(to.y - from.y) / length) * 1.4;
    const iy = ((to.x - from.x) / length) * 1.4;
    g.moveTo(from.x + ix, from.y + iy)
      .lineTo(to.x + ix, to.y + iy)
      .stroke({ width: 1.2, color, alpha: 0.85, cap: 'round' });
  }
}

function drawOutline(g: Graphics, silhouette: readonly Point[]): void {
  g.poly([...silhouette]).stroke({ width: OUTLINE.width, color: OUTLINE.color, alpha: 0.95, join: 'round' });
}

function drawCrystal(g: Graphics, art: CrystalArt): void {
  for (const facet of art.facets) drawBands(g, facet.bands);
  drawRim(g, art.rim, art.rimColor);
  drawOutline(g, art.silhouette);
  art.glints.forEach((glint, i) => {
    drawStar(g, glint.x, glint.y, glint.size, i === 0 ? 0.95 : 0.7);
  });
}

function drawCore(g: Graphics, art: CoreArt): void {
  for (const ray of art.rays) drawBands(g, ray.bands);
  for (const ring of art.body.rings) g.circle(0, 0, ring.radius).fill(ring.color);
  drawRim(g, art.rim, art.rimColor);
  drawOutline(g, art.silhouette);
  for (const glint of art.glints) drawStar(g, glint.x, glint.y, glint.size);
}

function drawSymbol(g: Graphics, art: SymbolArt): void {
  if (art.kind === 'crystal') drawCrystal(g, art);
  else drawCore(g, art);
}

function roundedCell(g: Graphics, fill: number, alpha = 1): Graphics {
  const half = CELL / 2 - BACKING_INSET;
  return g.roundRect(-half, -half, 2 * half, 2 * half, BACKING_RADIUS).fill({ color: fill, alpha });
}

/** Тёмное стекло cave-1 с тонкой верхней кромкой (§9). */
function drawBacking(g: Graphics): void {
  const half = CELL / 2 - BACKING_INSET;
  roundedCell(g, PALETTE.cave1);
  g.roundRect(-half + 2, -half + 2, 2 * half - 4, half, BACKING_RADIUS - 2).fill({ color: 0xffffff, alpha: 0.035 });
  g.moveTo(-half + BACKING_RADIUS, -half + 1)
    .lineTo(half - BACKING_RADIUS, -half + 1)
    .stroke({ width: 1.5, color: PALETTE.frame, alpha: 0.4, cap: 'round' });
  g.moveTo(-half + BACKING_RADIUS, half - 1)
    .lineTo(half - BACKING_RADIUS, half - 1)
    .stroke({ width: 1, color: PALETTE.glow, alpha: 0.14, cap: 'round' });
}

/** Подсвеченная подложка множителя: светлое стекло под tint уровня (×2…×64). */
function drawBackingLit(g: Graphics): void {
  const half = CELL / 2 - BACKING_INSET;
  roundedCell(g, 0xc9c9c9);
  g.roundRect(-half + 2, -half + 2, 2 * half - 4, half, BACKING_RADIUS - 2).fill({ color: 0xffffff, alpha: 0.35 });
  g.moveTo(-half + BACKING_RADIUS, -half + 1)
    .lineTo(half - BACKING_RADIUS, -half + 1)
    .stroke({ width: 1.5, color: 0xffffff, alpha: 0.9, cap: 'round' });
}

/** ×128 — белый с переливом: радужные пятна дисперсии поверх светлого стекла. */
function drawBackingIridescent(g: Graphics): void {
  drawBackingLit(g);
  const spots: readonly (readonly [number, number])[] = [
    [-14, -12],
    [14, -8],
    [-8, 14],
    [12, 14],
  ];
  spots.forEach(([x, y], i) => {
    g.circle(x, y, 16).fill({ color: DISPERSION[i % DISPERSION.length] ?? 0xffffff, alpha: 0.4 });
  });
}

/** Отметка — тонкое бирюзовое кольцо (§9). */
function drawMark(g: Graphics): void {
  const radius = CELL / 2 - BACKING_INSET - 4;
  g.circle(0, 0, radius).fill({ color: PALETTE.glow, alpha: 0.06 });
  g.circle(0, 0, radius).stroke({ width: 2, color: PALETTE.glow, alpha: 0.85 });
}

/**
 * Кромка множителя (фаза 5): белое кольцо вокруг подложки под tint уровня. Подложка остаётся тёмной (решение владельца:
 * светлые подложки не держат 3:1) — цвет уровня уходит в кромку и число. Кромка лежит в зазоре между подложками.
 */
function drawSpotRim(g: Graphics): void {
  const half = CELL / 2 - BACKING_INSET;
  // Кольцо — от края подложки (отступ 3) до 0.5 от края клетки, тонкий ореол — до самого края: кадр не шире клетки.
  g.roundRect(-half - 1.25, -half - 1.25, 2 * half + 2.5, 2 * half + 2.5, BACKING_RADIUS + 1.25).stroke({ width: 2.5, color: 0xffffff, alpha: 1 });
  g.roundRect(-half - 2.6, -half - 2.6, 2 * half + 5.2, 2 * half + 5.2, BACKING_RADIUS + 2.6).stroke({ width: 0.8, color: 0xffffff, alpha: 0.4 });
}

/** ×128 — белая кромка с переливом: стороны окрашены оттенками дисперсии, углы — белые. */
function drawSpotRimIridescent(g: Graphics): void {
  drawSpotRim(g);
  const edge = CELL / 2 - BACKING_INSET + 1.25;
  const span = edge - BACKING_RADIUS - 2;
  const sides: readonly (readonly [number, number, number, number])[] = [
    [-span, -edge, span, -edge],
    [edge, -span, edge, span],
    [span, edge, -span, edge],
    [-edge, span, -edge, -span],
  ];
  sides.forEach(([x0, y0, x1, y1], i) => {
    g.moveTo(x0, y0)
      .lineTo(x1, y1)
      .stroke({ width: 2.5, color: DISPERSION[i % DISPERSION.length] ?? 0xffffff, alpha: 0.9, cap: 'round' });
  });
}

/** Плашка числа множителя: тёмная пилюля с тонкой светлой кромкой; число поверх — цвета уровня. */
function drawChip(g: Graphics): void {
  const { width, height } = CHIP;
  g.roundRect(-width / 2, -height / 2, width, height, height / 2).fill({ color: PALETTE.cave0, alpha: 0.92 });
  g.roundRect(-width / 2 + 0.75, -height / 2 + 0.75, width - 1.5, height - 1.5, height / 2 - 0.75).stroke({ width: 1, color: 0xffffff, alpha: 0.22 });
}

/** Замок фриспинов: дужка и корпус, белый под tint. */
function drawLock(g: Graphics): void {
  g.moveTo(-3.5, -1)
    .lineTo(-3.5, -3.5)
    .arc(0, -3.5, 3.5, Math.PI, 0)
    .lineTo(3.5, -1)
    .stroke({ width: 1.8, color: 0xffffff, alpha: 1, cap: 'round' });
  g.roundRect(-6, -1.5, 12, 9, 2).fill({ color: 0xffffff, alpha: 1 });
  g.circle(0, 2.5, 1.3).fill({ color: PALETTE.cave0, alpha: 0.9 });
}

/** Панель плашек фичи: тёмное стекло, бирюзовая внутренняя кромка, светлая внешняя. */
function drawPanel(g: Graphics, size: number): void {
  const half = size / 2 - 1;
  const radius = PANEL_BORDER - 8;
  g.roundRect(-half, -half, 2 * half, 2 * half, radius).fill({ color: PALETTE.cave1, alpha: 0.94 });
  g.roundRect(-half + 3, -half + 3, 2 * half - 6, 2 * half - 6, radius - 3).stroke({ width: 1.5, color: PALETTE.glow, alpha: 0.55 });
  g.roundRect(-half + 0.75, -half + 0.75, 2 * half - 1.5, 2 * half - 1.5, radius).stroke({ width: 1.5, color: PALETTE.frame, alpha: 0.45 });
}

/**
 * Исходник рамки для NineSliceSprite: квадрат FRAME_SLICE, край FRAME_BORDER, середина прозрачна.
 * Каждая сторона — две полосы-грани: внешняя смотрит наружу, внутренняя — к сетке; свет — та же модель, что у
 * кристаллов (ключевой сверху слева, бирюзовый контровой снизу).
 */
function drawFrameSlice(g: Graphics, size: number): void {
  const outer = size / 2;
  const inner = outer - FRAME_BORDER;
  const ridge = outer - FRAME_BORDER / 2;
  // Сталь грота: темнее токена frame, чтобы рамка держала сетку, а не спорила с ней; грани крутые — стороны
  // расходятся по свету: верх и лево ловят ключевой, низ — бирюзовый контровой.
  const albedo = mix(PALETTE.frame, PALETTE.cave1, 0.5);
  const out = 0.95;
  const into = 0.75;
  // Стороны по часовой стрелке: верх, право, низ, лево; (nx, ny) — наружу.
  const sides: readonly (readonly [number, number])[] = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  const corner = (r: number, along: number, nx: number, ny: number): Point =>
    // Точка на квадрате радиуса r: along = −1 — левый конец стороны при взгляде снаружи, +1 — правый.
    ({ x: nx * r - ny * along * r, y: ny * r + nx * along * r });
  for (const [nx, ny] of sides) {
    const band = (from: number, to: number, normal: { x: number; y: number; z: number }): void => {
      g.poly([corner(from, -1, nx, ny), corner(from, 1, nx, ny), corner(to, 1, nx, ny), corner(to, -1, nx, ny)]).fill(shade(albedo, normal));
    };
    band(outer, ridge, { x: nx * Math.sin(out), y: ny * Math.sin(out), z: Math.cos(out) });
    band(ridge, inner, { x: -nx * Math.sin(into), y: -ny * Math.sin(into), z: Math.cos(into) });
  }
  g.rect(-ridge, -ridge, 2 * ridge, 2 * ridge).stroke({ width: 0.8, color: 0xffffff, alpha: 0.4 });
  g.rect(-outer + 0.75, -outer + 0.75, 2 * outer - 1.5, 2 * outer - 1.5).stroke({ width: 1.5, color: OUTLINE.color, alpha: 0.95 });
  g.rect(-inner, -inner, 2 * inner, 2 * inner).stroke({ width: 1.5, color: OUTLINE.color, alpha: 0.95 });
  g.rect(-inner + 1.4, -inner + 1.4, 2 * inner - 2.8, 2 * inner - 2.8).stroke({ width: 1, color: PALETTE.glow, alpha: 0.35 });
}

/** Свечение для подсветки: силуэт, расширенный от 1.3 до 1 шагами с малой альфой, и сам силуэт поверх. */
function drawGlow(g: Graphics, silhouette: readonly Point[]): void {
  const steps = 10;
  for (let i = 0; i < steps; i++) {
    const k = 1.3 - (0.3 * i) / steps;
    g.poly(silhouette.map((p) => ({ x: p.x * k, y: p.y * k }))).fill({ color: 0xffffff, alpha: 0.08 });
  }
  g.poly([...silhouette]).fill({ color: 0xffffff, alpha: 0.6 });
}

/** Мягкий блик: вложенные эллипсы с малой альфой — мягкий край без текстуры градиента. */
function drawSoft(g: Graphics, rx: number, ry: number, steps: number, alpha: number): void {
  for (let i = 0; i < steps; i++) {
    const k = 1 - i / steps;
    g.ellipse(0, 0, rx * k, ry * k).fill({ color: 0xffffff, alpha });
  }
}

export class CrystalAtlas {
  readonly plan: AtlasPlan;
  readonly #texture: RenderTexture;
  readonly #frames = new Map<AtlasKey, Texture>();

  constructor(renderer: Renderer) {
    this.plan = planAtlas(atlasEntries());
    const { resolution } = this.plan;
    this.#texture = RenderTexture.create({
      width: this.plan.width / resolution,
      height: this.plan.height / resolution,
      resolution,
      antialias: true,
      autoGenerateMipmaps: true,
      label: 'crystal-atlas',
    });
    for (const frame of this.plan.frames) {
      const rect = new Rectangle(frame.x / resolution, frame.y / resolution, frame.width / resolution, frame.height / resolution);
      this.#frames.set(frame.key, new Texture({ source: this.#texture.source, frame: rect, label: frame.key }));
    }
    const bake = new Container();
    const at = (key: AtlasKey, parent: Container): Graphics => {
      const target = this.texture(key).frame;
      const g = new Graphics();
      g.position.set(target.x + target.width / 2, target.y + target.height / 2);
      parent.addChild(g);
      return g;
    };
    for (let s = 0; s < SYMBOL_COUNT; s++) {
      const symbol = s as SymbolId;
      const art = symbolArt(symbol);
      drawSymbol(at(symbolKey(symbol), bake), art);
      drawGlow(at(glowKey(symbol), bake), art.silhouette);
      art.shards.slice(0, SHARDS_PER_SYMBOL).forEach((shard, k) => {
        at(shardKey(symbol, k as ShardIndex), bake)
          .poly([...shard.points])
          .fill(shard.color)
          .stroke({ width: 1, color: OUTLINE.color, alpha: 0.8, join: 'round' });
      });
    }
    drawBacking(at('backing', bake));
    drawBackingLit(at('backing-lit', bake));
    drawBackingIridescent(at('backing-iridescent', bake));
    drawMark(at('mark', bake));
    drawFrameSlice(at('frame-slice', bake), this.texture('frame-slice').frame.width);
    drawSoft(at('glint-streak', bake), 62, 6, 10, 0.1);
    drawStar(at('star', bake), 0, 0, 11);
    drawSoft(at('dot', bake), 7, 7, 7, 0.14);
    drawSpotRim(at('rim', bake));
    drawSpotRimIridescent(at('rim-iridescent', bake));
    drawChip(at('chip', bake));
    drawLock(at('lock', bake));
    drawPanel(at('panel', bake), this.texture('panel').frame.width);
    renderer.render({ container: bake, target: this.#texture, clear: true });
    this.#texture.source.updateMipmaps();
    bake.destroy({ children: true });
  }

  texture(key: AtlasKey): Texture {
    const texture = this.#frames.get(key);
    if (texture === undefined) throw new Error(`в атласе нет кадра ${key}`);
    return texture;
  }

  /** Весь атлас одной текстурой — для выгрузки на просмотр. */
  get whole(): RenderTexture {
    return this.#texture;
  }

  /**
   * Кадры и текстура — без источника. В Pixi 8.21 группы привязок батча WebGPU живут в модульном кэше
   * (getTextureBatchBindGroup) дольше приложения, и уничтожение источника даёт предупреждение «destroyed while
   * still bound» даже после app.destroy. GPU-память источника уходит вместе с рендерером: WebGPU — device.destroy,
   * WebGL — потеря контекста; JS-объект остаётся в кэше Pixi — по одному на перемонтирование рендерера.
   */
  destroy(): void {
    for (const texture of this.#frames.values()) texture.destroy(false);
    this.#frames.clear();
    this.#texture.destroy(false);
  }
}
