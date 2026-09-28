// Фон грота (§9): один полноэкранный шейдер, пара GLSL и WGSL. Меш — четырёхугольник в координатах отсечения,
// поэтому он всегда на весь канвас (cover) и не зависит от раскладки. Время — часы декора: при reduced motion
// оно стоит, в тестах — закреплено. Один draw-call; цена на пиксель — в шапке cave.frag.

import { Mesh, MeshGeometry, Shader, UniformGroup } from 'pixi.js';
import { toScreen, type Layout } from '../layout.ts';
import fragment from './shaders/cave.frag?raw';
import vertex from './shaders/cave.vert?raw';
import source from './shaders/cave.wgsl?raw';

/** Свет ядра: центр под сеткой, радиус и сила — в долях сетки. */
const CORE_BELOW = 0.12;
const CORE_RADIUS = 0.95;
const CORE_STRENGTH = 0.9;

export class CaveBackground {
  readonly view: Mesh<MeshGeometry, Shader>;
  readonly #uniforms = new UniformGroup({
    uResolution: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
    uTime: { value: 0, type: 'f32' },
    uWarmth: { value: 0, type: 'f32' },
    uCore: { value: new Float32Array([0, 0, 1, 0]), type: 'vec4<f32>' },
  });

  constructor() {
    const geometry = new MeshGeometry({
      positions: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
      // (0, 0) — левый верх экрана: y кадра растёт вниз в обоих рендерерах.
      uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const shader = Shader.from({
      gl: { vertex, fragment, name: 'cave' },
      gpu: {
        vertex: { entryPoint: 'mainVert', source },
        fragment: { entryPoint: 'mainFrag', source },
        name: 'cave',
      },
      resources: { caveUniforms: this.#uniforms },
    });
    this.view = new Mesh<MeshGeometry, Shader>({ geometry, shader, label: 'cave-background' });
  }

  /** Размер канваса и место ядра — по раскладке, CSS-пиксели. */
  layout(layout: Layout): void {
    const resolution = this.#uniforms.uniforms['uResolution'] as Float32Array;
    resolution[0] = Math.max(1, layout.viewport.width);
    resolution[1] = Math.max(1, layout.viewport.height);
    const grid = toScreen(layout, layout.design.zones.grid);
    const core = this.#uniforms.uniforms['uCore'] as Float32Array;
    core[0] = grid.x + grid.width / 2;
    core[1] = grid.y + grid.height * (1 + CORE_BELOW);
    core[2] = Math.max(1, grid.width * CORE_RADIUS);
    core[3] = CORE_STRENGTH;
  }

  /** Время декора, секунды; тепло фриспинов 0…1 (§9). */
  update(seconds: number, warmth: number): void {
    this.#uniforms.uniforms['uTime'] = seconds;
    this.#uniforms.uniforms['uWarmth'] = warmth;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
