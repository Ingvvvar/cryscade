// План общего атласа §9: что в нём лежит и где. Выпекает его render/pixi, здесь — только размеры и упаковка.
// Всё в одной базовой текстуре — один батч. Разрешение 2× к единицам дизайна; бюджет — 2048×2048 (§13).

import { SYMBOL_COUNT, type SymbolId } from '../../core/model/symbols.ts';
import { SHARD_RADIUS, SHARDS_PER_SYMBOL } from './crystal.ts';
import { CELL } from '../layout.ts';

export const ATLAS_RESOLUTION = 2;
export const ATLAS_MAX_SIZE = 2048;
/** Пикселей между кадрами и от края: линейная выборка и мипмапы не цепляют соседа. */
export const ATLAS_PADDING = 2;
/** Поле вокруг силуэта под размытие свечения, единицы дизайна. */
export const GLOW_MARGIN = 14;
/** Исходник рамки для NineSliceSprite: угол и край. */
export const FRAME_SLICE = 64;
/** Плашка числа множителя — NineSliceSprite по ширине числа: концы-полукруги по CHIP.cap. */
export const CHIP = { width: 40, height: 20, cap: 10 } as const;
/** Панель плашек фичи — NineSliceSprite: угол и край. */
export const PANEL_SLICE = 96;
export const PANEL_BORDER = 32;

export type ShardIndex = 0 | 1 | 2;

export type AtlasKey =
  | `symbol-${SymbolId}`
  | `glow-${SymbolId}`
  | `shard-${SymbolId}-${ShardIndex}`
  | 'backing'
  | 'backing-lit'
  | 'backing-iridescent'
  | 'mark'
  | 'frame-slice'
  | 'glint-streak'
  | 'star'
  | 'dot'
  | 'rim'
  | 'rim-iridescent'
  | 'chip'
  | 'lock'
  | 'panel';

export function symbolKey(symbol: SymbolId): AtlasKey {
  return `symbol-${String(symbol)}` as `symbol-${SymbolId}`;
}

export function glowKey(symbol: SymbolId): AtlasKey {
  return `glow-${String(symbol)}` as `glow-${SymbolId}`;
}

export function shardKey(symbol: SymbolId, index: ShardIndex): AtlasKey {
  return `shard-${String(symbol)}-${String(index)}` as `shard-${SymbolId}-${ShardIndex}`;
}

/** Размер в единицах дизайна. */
export interface AtlasEntry {
  readonly key: AtlasKey;
  readonly width: number;
  readonly height: number;
}

/** Кадр в пикселях атласа. */
export interface AtlasFrame {
  readonly key: AtlasKey;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AtlasPlan {
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  readonly frames: readonly AtlasFrame[];
}

export function atlasEntries(): AtlasEntry[] {
  const symbols = Array.from({ length: SYMBOL_COUNT }, (_, i) => i as SymbolId);
  const shard = 2 * SHARD_RADIUS + 4;
  return [
    ...symbols.map((s): AtlasEntry => ({ key: symbolKey(s), width: CELL, height: CELL })),
    ...symbols.map((s): AtlasEntry => ({ key: glowKey(s), width: CELL + 2 * GLOW_MARGIN, height: CELL + 2 * GLOW_MARGIN })),
    ...symbols.flatMap((s) =>
      Array.from({ length: SHARDS_PER_SYMBOL }, (_, k): AtlasEntry => ({ key: shardKey(s, k as ShardIndex), width: shard, height: shard })),
    ),
    { key: 'backing', width: CELL, height: CELL },
    { key: 'backing-lit', width: CELL, height: CELL },
    { key: 'backing-iridescent', width: CELL, height: CELL },
    { key: 'mark', width: CELL, height: CELL },
    { key: 'frame-slice', width: FRAME_SLICE, height: FRAME_SLICE },
    { key: 'glint-streak', width: 128, height: 16 },
    { key: 'star', width: 24, height: 24 },
    { key: 'dot', width: 16, height: 16 },
    // Фаза 5: кромка множителя (цвет уровня — tint), плашка числа, замок фриспинов, панель плашек фичи.
    { key: 'rim', width: CELL, height: CELL },
    { key: 'rim-iridescent', width: CELL, height: CELL },
    { key: 'chip', width: CHIP.width, height: CHIP.height },
    { key: 'lock', width: 14, height: 16 },
    { key: 'panel', width: PANEL_SLICE, height: PANEL_SLICE },
  ];
}

/** Полки: кадры по убыванию высоты слева направо; новая полка — когда ряд не влезает. Высота атласа — степень двойки. */
export function planAtlas(entries: readonly AtlasEntry[], resolution = ATLAS_RESOLUTION, maxSize = ATLAS_MAX_SIZE, padding = ATLAS_PADDING): AtlasPlan {
  const sized = entries
    .map((entry, order) => ({ entry, order, width: Math.ceil(entry.width * resolution), height: Math.ceil(entry.height * resolution) }))
    .sort((a, b) => b.height - a.height || a.order - b.order);
  const frames: AtlasFrame[] = [];
  let x = padding;
  let y = padding;
  let shelf = 0;
  for (const { entry, width, height } of sized) {
    if (width + 2 * padding > maxSize) throw new RangeError(`${entry.key}: шире атласа`);
    if (x + width + padding > maxSize) {
      x = padding;
      y += shelf + padding;
      shelf = 0;
    }
    frames.push({ key: entry.key, x, y, width, height });
    x += width + padding;
    shelf = Math.max(shelf, height);
  }
  const used = y + shelf + padding;
  let height = 1;
  while (height < used) height *= 2;
  if (height > maxSize) throw new RangeError(`атлас не влез: нужно ${String(used)} px по высоте`);
  return { width: maxSize, height, resolution, frames };
}
