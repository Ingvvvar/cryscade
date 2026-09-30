// Фасад рендера для ui/ (§3): интерфейсы маленькие, под потребителя. Через них идут простые данные.
// Реализация — PixiRenderer в render/pixi/; ui/ знает только эти интерфейсы, кроме корня композиции.

import type { SceneState, Schedule } from '../core/presentation/index.ts';
import type { Viewport } from './layout.ts';

export type RendererName = 'webgpu' | 'webgl';

/** Фактический рендерер: имя и строка GPU — ими подписываются замеры и снимки. */
export interface RendererInfo {
  readonly name: RendererName;
  readonly gpu: string;
  /** Программный рендер (SwiftShader, запасной адаптер WebGPU): на нём производительность не мерят. */
  readonly software: boolean;
}

/** Жизненный цикл — для SceneMount. init асинхронный; канвас рендерер создаёт в host сам и сам убирает в destroy. */
export interface RendererLifecycle {
  init(host: HTMLElement): Promise<RendererInfo>;
  destroy(): void;
}

/** Вьюпорт и reduced motion — для наблюдателя за окном. pixelRatio — devicePixelRatio экрана как есть. */
export interface ViewportSink {
  resize(viewport: Viewport, pixelRatio: number): void;
  setReducedMotion(on: boolean): void;
}

/** Надписи сцены — строками от ui (§9): в render/ текста нет. Набор глифов шрифта надписей — из них. */
export interface SceneTexts {
  /** Счётчик фриспинов и плашка их начала. */
  readonly freeSpins: string;
  /** Плашка ретриггера. */
  readonly moreFreeSpins: string;
  /** Подсказка featureIntro: показ ждёт тапа или пробела. */
  readonly tapToContinue: string;
  /** Плашка капа. */
  readonly maxWin: string;
  /** Уровни большого выигрыша 1…4. */
  readonly bigWin: readonly [string, string, string, string];
}

/** Все строки надписей — для набора глифов и проверки, что ни одного не недостаёт. */
export function sceneTextList(texts: SceneTexts): string[] {
  return [texts.freeSpins, texts.moreFreeSpins, texts.tapToContinue, texts.maxWin, ...texts.bigWin];
}

/**
 * Источник кадра (§3): часы показа и состояние сцены. Тикер рендера двигает часы и ставит кадр на экран — рендер ничего
 * не решает. Расписание — чтобы раз на раунд построить контуры по его геометрии.
 */
export interface SceneSource {
  tick(deltaMs: number): SceneState;
  readonly schedule: Schedule | null;
  /** Показ дошёл до конца расписания. */
  readonly finished: boolean;
}

export interface SourceSink {
  setSource(source: SceneSource | null): void;
}

export interface Renderer extends RendererLifecycle, ViewportSink, SourceSink {}
