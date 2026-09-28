// Прогрев шейдеров §10: до первого кадра — одна отрисовка сцены во внеэкранную текстуру 1×1, без следа на экране
// (канвас ещё не в DOM). Текстура — в формате и с MSAA канваса: WebGPU-конвейеры Pixi кэшируются на состояние
// прохода, и прогрев в чужом формате не прогрел бы конвейер канваса (мутация rgba8unorm ловится тестом прогрева).
// Сцена в момент init содержит все свои режимы смешивания: блик рамки при времени декора 0 на ней есть.
// Аддитивные подсветки фазы 5, которых на сцене в момент init нет, прогрев должен будет покрыть отдельно.

import { RenderTexture, type Container, type Renderer } from 'pixi.js';

export function warmUp(renderer: Renderer, stage: Container): void {
  const view = renderer.view;
  const target = RenderTexture.create({ width: 1, height: 1, resolution: 1, format: view.texture.source.format, antialias: view.antialias });
  renderer.render({ container: stage, target, clear: true });
  // Цель прогрева в батч не попадает (в неё рисуют, а не из неё берут), её можно уничтожить.
  target.destroy(true);
}
