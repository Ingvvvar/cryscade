// Типы тестового зонда страницы — без Pixi: их импортируют e2e-тесты, а тесты Node не тянут pixi.js (§3).
// Сам зонд — ui/probe.ts, только dev и e2e-сборка.

import type { ControllerSnapshot, LabSettings, ShownRound } from '../client/index.ts';
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

/** Параметры показа для снимка: скорость, строгий пресет, reduced motion. */
export interface StillOptions {
  readonly speed?: 'normal' | 'turbo';
  readonly strict?: boolean;
  readonly reducedMotion?: boolean;
}

/** Расписание показа простыми данными: тест выбирает момент кадра по группам и сегментам. */
export interface ScheduleSummary {
  readonly durationMs: number;
  readonly groups: readonly { readonly kind: string; readonly startMs: number; readonly endMs: number }[];
  readonly segments: readonly { readonly kind: string; readonly group: number; readonly startMs: number; readonly endMs: number }[];
  readonly bigWinLevel: number;
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
  /** Показ стоит на tMs раунда round — кадр для снимков и draw-call (поддельные часы показа). */
  still(round: ShownRound, tMs: number, options?: StillOptions): void;
  /** Расписание текущего показа; null — показа нет. */
  schedule(): ScheduleSummary | null;
  /** Символы, которых нет в шрифтах: без аргумента — надписи и числа самой сцены, иначе — эти строки шрифтом надписей. */
  missingGlyphs(texts?: string[]): string[];
  /** Плашки чисел множителей на экране, CSS-пиксели. */
  chipRects(): Rect[];
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
