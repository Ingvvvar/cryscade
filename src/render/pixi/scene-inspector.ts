// Крючок для тестового зонда (dev и e2e-сборка). В проде инспектора нет: рендерер получает null,
// а сам зонд подключается динамическим импортом под условием сборки и в прод-бандл не попадает (§15, фаза 3).

import type { Application, Container } from 'pixi.js';
import type { ChipRect, Layout } from '../layout.ts';
import type { RendererInfo, SceneLabels } from '../renderer.ts';
import type { CrystalAtlas } from './atlas.ts';

/** То, что рендерер открывает зонду, пока жив. */
export interface InspectableScene {
  readonly app: Application;
  readonly info: RendererInfo;
  readonly atlas: CrystalAtlas;
  /** Корень сцены в единицах дизайна: сюда зонд кладёт контрольные спрайты. */
  readonly root: Container;
  /** document.fonts видел Unbounded, когда ставился BitmapFont. */
  readonly fontReady: boolean;
  layout(): Layout | null;
  /** Показ дошёл до конца, сетка на поле и стоит. */
  settled(): boolean;
  /** Кадр источника на deltaMs без хода декора — для кадра при остановленном тикере. */
  step(deltaMs: number): void;
  /** Символы, которых нет в шрифтах: null — надписи и числа самой сцены, иначе — эти строки шрифтом надписей. */
  missingGlyphs(texts: readonly string[] | null): string[];
  /** Плашки чисел множителей на экране, CSS-пиксели: проверка читаемости меряет подложку мимо них. */
  chipRects(): ChipRect[];
  /** Надпись видимой плашки фичи; плашки нет — null. */
  plaqueText(): string | null;
  /** Надписи и сумма на сцене. */
  labels(): SceneLabels;
  /** Закрепить время декора (фон, блик рамки); null — снять. */
  pinAmbient(seconds: number | null): void;
  /** Только фон: для паритета GLSL и WGSL. */
  backgroundOnly(on: boolean): void;
}

export interface SceneInspector {
  attach(scene: InspectableScene): void;
  detach(scene: InspectableScene): void;
}
