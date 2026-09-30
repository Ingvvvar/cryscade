// Прогрев §10 до первого кадра, без следа на экране (канвас ещё не в DOM).
// Текстуры, которых нет на сцене в момент init (страницы глифов надписей), грузятся в GPU вместе с мипмапами:
// renderer.texture.initSource. Иначе их загрузка и мипмапы (WebGPU — проходами с draw) пришлись бы на первый кадр
// фичи или большого выигрыша.
// Шейдеры — одна отрисовка сцены во внеэкранную текстуру 1×1. Текстура — в формате и с MSAA канваса: WebGPU-конвейеры
// Pixi кэшируются на состояние прохода, и прогрев в чужом формате не прогрел бы конвейер канваса (мутация rgba8unorm
// ловится тестом прогрева). Сцена в момент init содержит все свои режимы смешивания: блик рамки при времени декора 0 на
// ней есть, а осколки и вспышки взрыва, которых в покое нет, показ раунда на время прогрева делает видимыми
// (RoundView.forWarmUp).

import { RenderTexture, type Container, type Renderer, type TextureSource } from 'pixi.js';

export function warmUp(renderer: Renderer, stage: Container, textures: readonly TextureSource[]): void {
  for (const source of textures) renderer.texture.initSource(source);
  const view = renderer.view;
  const target = RenderTexture.create({ width: 1, height: 1, resolution: 1, format: view.texture.source.format, antialias: view.antialias });
  renderer.render({ container: stage, target, clear: true });
  // Цель прогрева в батч не попадает (в неё рисуют, а не из неё берут), её можно уничтожить.
  target.destroy(true);
}
