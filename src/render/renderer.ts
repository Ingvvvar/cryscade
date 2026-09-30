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
  /** Плашка ретриггера — «+5 фріспінів»: число — из fsRetrigger, форма слова — забота ui. */
  freeSpinsAdded(count: number): string;
  /** Подсказка featureIntro: показ ждёт тапа или пробела. */
  readonly tapToContinue: string;
  /** Плашка капа. */
  readonly maxWin: string;
  /** Уровни большого выигрыша 1…4. */
  readonly bigWin: readonly [string, string, string, string];
}

/**
 * Надпись ретриггера — с числом: набор глифов берёт её на всех числах от 0 до 99. Так в нём все цифры и все формы слова:
 * форму при целом числе правила множины CLDR выбирают по остаткам от деления на 10 и на 100.
 */
const COUNT_SAMPLES = 100;

/** Все строки надписей — для набора глифов и проверки, что ни одного не недостаёт. */
export function sceneTextList(texts: SceneTexts): string[] {
  const added = Array.from({ length: COUNT_SAMPLES }, (_, count) => texts.freeSpinsAdded(count));
  return [texts.freeSpins, texts.tapToContinue, texts.maxWin, ...texts.bigWin, ...added];
}

/**
 * Источник кадра (§3): часы показа и состояние сцены. Тикер рендера двигает часы и ставит кадр на экран — рендер ничего
 * не решает. Расписание — чтобы раз на раунд построить контуры по его геометрии.
 */
export interface SceneSource {
  /** Ход часов на deltaMs — целые миллисекунды: дробное время тикера округляют часы кадра (frame-clock.ts). */
  tick(deltaMs: number): SceneState;
  readonly schedule: Schedule | null;
  /** Показ дошёл до конца расписания. */
  readonly finished: boolean;
}

export interface SourceSink {
  setSource(source: SceneSource | null): void;
}

export interface Renderer extends RendererLifecycle, ViewportSink, SourceSink {}
