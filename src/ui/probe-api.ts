// Типы тестового зонда страницы — без Pixi: их импортируют e2e-тесты, а тесты Node не тянут pixi.js (§3).
// Сам зонд — ui/probe.ts, только dev и e2e-сборка.

import type { Layout, Rect } from '../render/layout.ts';
import type { RendererInfo } from '../render/renderer.ts';

export interface ProbeSceneInfo extends RendererInfo {
  readonly maxBatchableTextures: number;
  readonly resolution: number;
}

export interface MountCounts {
  /** Эффект смонтирован. */
  readonly attaches: number;
  readonly detaches: number;
  /** Рендереров создано фабрикой. */
  readonly created: number;
  /** Рендереров дошло до конца init. */
  readonly inits: number;
  readonly destroys: number;
}

export type ControlSprites = 'distinct' | 'atlas';

export interface CryscadeProbe {
  info(): ProbeSceneInfo | null;
  mounts(): MountCounts;
  errors(): string[];
  layout(): Layout | null;
  cells(): Rect[];
  settled(): boolean;
  renderOnce(): void;
  stopTicker(): void;
  startTicker(): void;
  addControlSprites(count: number, kind: ControlSprites): void;
  removeControlSprites(): void;
  /** Снять и снова повесить сессию на живой сцене: живой рендерер уничтожается, новый проходит init. */
  remount(): void;
}
