// Типы тестового зонда страницы — без Pixi: их импортируют e2e-тесты, а тесты Node не тянут pixi.js (§3).
// Сам зонд — ui/probe.ts, только dev и e2e-сборка.

import type { ControllerSnapshot, LabSettings } from '../client/index.ts';
import type { Layout, Rect } from '../render/layout.ts';
import type { RendererInfo } from '../render/renderer.ts';

export interface ProbeSceneInfo extends RendererInfo {
  readonly maxBatchableTextures: number;
  readonly resolution: number;
  /** document.fonts видел Unbounded, когда ставился BitmapFont. */
  readonly fontReady: boolean;
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

/** Лаборатория сети этой вкладки (§6.5): e2e провоцирует сбои через неё. */
export interface ProbeLab {
  set(settings: Partial<LabSettings>): void;
  loseNextResponse(): void;
  reloadMidNextRound(): void;
  holdNextEndRound(): void;
  releaseHeld(): void;
}

export interface CryscadeProbe {
  info(): ProbeSceneInfo | null;
  mounts(): MountCounts;
  errors(): string[];
  layout(): Layout | null;
  cells(): Rect[];
  settled(): boolean;
  renderOnce(): void;
  /** Закрепить время декора (фон, блик рамки); null — снять. */
  pinAmbient(seconds: number | null): void;
  backgroundOnly(on: boolean): void;
  atlasPng(): Promise<string | null>;
  stopTicker(): void;
  startTicker(): void;
  addControlSprites(count: number, kind: ControlSprites): void;
  removeControlSprites(): void;
  /** Снять и снова повесить сессию на живой сцене: живой рендерер уничтожается, новый проходит init. */
  remount(): void;
  /** Снимок контроллера игры; null — игра ещё не связана. */
  game(): ControllerSnapshot | null;
  /** id раундов, которые вкладка показала, по порядку: свои и доигранные. */
  shownRounds(): string[];
  /** Тела запросов, ушедших в воркер после лаборатории сети: что дошло до сервера. */
  sent(): SentBody[];
  readonly lab: ProbeLab;
}

export interface SentBody {
  readonly type: string;
  readonly idempotencyKey?: string;
  readonly roundId?: string;
}
