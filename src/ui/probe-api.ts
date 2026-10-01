// Типы тестового зонда страницы — без Pixi: их импортируют e2e-тесты, а тесты Node не тянут pixi.js (§3).
// Сам зонд — ui/probe.ts, только dev и e2e-сборка.

import type { ControllerSnapshot, LabSettings, ShownRound } from '../client/index.ts';
import type { ChipRect, Layout, Rect } from '../render/layout.ts';
import type { RendererInfo, SceneLabels } from '../render/renderer.ts';
import type { ForcedName } from './forced-rounds.ts';

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
  /** unit — единица пропуска (§8.2): спин или празднование большого выигрыша. */
  readonly groups: readonly { readonly kind: string; readonly startMs: number; readonly endMs: number; readonly unit: number }[];
  readonly segments: readonly { readonly kind: string; readonly group: number; readonly startMs: number; readonly endMs: number }[];
  readonly bigWinLevel: number;
}

/** Часы показа простыми данными: где показ сейчас и по какому расписанию. */
export interface PresentationInfo {
  readonly clock: number;
  /** С какого момента начался показ раунда: 0 — новый, начало группы контрольной точки — восстановленный. */
  readonly startMs: number;
  readonly group: number;
  /** Начала групп расписания, мс: контрольная точка — индекс в этом списке. */
  readonly groupStarts: readonly number[];
  readonly durationMs: number;
  readonly held: boolean;
  readonly finished: boolean;
  readonly speed: 'normal' | 'turbo';
  readonly reducedMotion: boolean;
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
  /** Часы текущего показа; null — показа нет. */
  presentation(): PresentationInfo | null;
  /** Сид следующего раунда по каналу зонда — мимо протокола; деньги идут обычным путём (фаза 5). Сбывается, когда воркер принял сид. */
  force(round: ForcedName | number): Promise<void>;
  /**
   * Пропуск показа тем же тапом, что у игрока, — тапы до конца показа: два на спин, один на плашку фриспинов и один на
   * празднование большого выигрыша. e2e без ожидания показа.
   */
  autoSkip(on: boolean): void;
  /** Символы, которых нет в шрифтах: без аргумента — надписи и числа самой сцены, иначе — эти строки шрифтом надписей. */
  missingGlyphs(texts?: string[]): string[];
  /** Плашки чисел множителей на экране, CSS-пиксели. */
  chipRects(): ChipRect[];
  /** Части плашек множителей на кадре: замок, число (по умолчанию — обе). Тест наложения снимает их порознь. */
  chipParts(lock: boolean, digits: boolean): void;
  /** Надпись видимой плашки фичи; плашки нет — null. */
  plaqueText(): string | null;
  /** Надписи и сумма на сцене; сцены нет — null. Смена языка доходит до каждой. */
  sceneLabels(): SceneLabels | null;
  /** Снимок контроллера игры; null — игра ещё не связана. */
  game(): ControllerSnapshot | null;
  /** id раундов, которые вкладка показала, по порядку: свои и доигранные. */
  shownRounds(): string[];
  /** Тела запросов, ушедших в воркер после лаборатории сети: что дошло до сервера. */
  sent(): SentBody[];
  /** Ответы воркера на запросы replay как есть — тело ответа: { ok, result } или { ok, error }. */
  replays(): unknown[];
  /** Коммиты дерева App с загрузки — React Profiler (§11: не больше 10 за раунд без ввода). */
  appCommits(): number;
  readonly lab: ProbeLab;
}

export interface SentBody {
  readonly type: string;
  readonly idempotencyKey?: string;
  readonly roundId?: string;
}
