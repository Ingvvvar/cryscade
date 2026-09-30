// Взрыв (§8.4, §10): осколки атласа в ParticleContainer — по три на клетку, все 147 частиц созданы заранее и делят
// базовую текстуру атласа; вспышка — звезда атласа, аддитивно. Кадр — функция хода взрыва клетки из SceneState:
// направления разлёта заданы при сборке, случайности в кадре нет. Reduced motion раунда — ни осколков, ни вспышек (§8.4).

import { Container, Particle, ParticleContainer, Rectangle, Sprite, type Texture } from 'pixi.js';
import { CELL_COUNT } from '../../core/model/grid.ts';
import { SYMBOL_COUNT, type SymbolId } from '../../core/model/symbols.ts';
import { EMPTY_CELL, type SceneState } from '../../core/presentation/index.ts';
import { shardKey, type ShardIndex } from '../art/atlas-plan.ts';
import { SHARDS_PER_SYMBOL } from '../art/crystal.ts';
import { CELL } from '../layout.ts';
import type { CrystalAtlas } from './atlas.ts';
import type { GridView } from './grid-view.ts';

/** Разлёт к концу взрыва и падение под тяжестью, единицы дизайна; поворот, радианы. */
const SPREAD = 0.8 * CELL;
const DROP = 0.45 * CELL;
const SPIN = 3;
/** Вспышка — первая часть взрыва; размер на пике — доля от кадра звезды. */
const FLASH_SHARE = 0.45;
const FLASH_GROWTH = 2.2;
/** Золотой угол: соседние клетки разлетаются по-разному без случайности. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export class ShardView {
  readonly view: ParticleContainer;
  readonly stars = new Container({ label: 'explosion-flashes' });
  readonly #particles: Particle[] = [];
  readonly #flashes: Sprite[] = [];
  readonly #textures: Texture[] = [];
  readonly #dirX = new Float64Array(CELL_COUNT * SHARDS_PER_SYMBOL);
  readonly #dirY = new Float64Array(CELL_COUNT * SHARDS_PER_SYMBOL);

  constructor(atlas: CrystalAtlas) {
    for (let symbol = 0; symbol < SYMBOL_COUNT; symbol++) {
      for (let k = 0; k < SHARDS_PER_SYMBOL; k++) this.#textures.push(atlas.texture(shardKey(symbol as SymbolId, k as ShardIndex)));
    }
    const first = this.#textures[0] ?? atlas.texture('star');
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      for (let k = 0; k < SHARDS_PER_SYMBOL; k++) {
        const angle = (2 * Math.PI * k) / SHARDS_PER_SYMBOL + cell * GOLDEN - Math.PI / 2;
        this.#dirX[cell * SHARDS_PER_SYMBOL + k] = Math.cos(angle);
        this.#dirY[cell * SHARDS_PER_SYMBOL + k] = Math.sin(angle);
        this.#particles.push(new Particle({ texture: first, anchorX: 0.5, anchorY: 0.5, alpha: 0 }));
      }
      const flash = new Sprite({ texture: atlas.texture('star'), anchor: 0.5, blendMode: 'add', visible: false });
      this.#flashes.push(flash);
      this.stars.addChild(flash);
    }
    // boundsArea обязателен (§10): частицы не считают границ. Обе раскладки — в квадрате 1280.
    this.view = new ParticleContainer({
      label: 'shards',
      texture: first,
      boundsArea: new Rectangle(0, 0, 1280, 1280),
      dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true },
    });
    this.view.addParticle(...this.#particles);
    this.view.update();
    this.view.visible = false;
  }

  /** Отрисовка прогрева с видимыми осколками и вспышкой: их конвейеры собираются до первого кадра. */
  forWarmUp(render: () => void): void {
    const flash = this.#flashes[0];
    const particle = this.#particles[0];
    this.view.visible = true;
    this.stars.visible = true;
    if (flash !== undefined) flash.visible = true;
    if (particle !== undefined) particle.alpha = 1;
    render();
    if (flash !== undefined) flash.visible = false;
    if (particle !== undefined) particle.alpha = 0;
    this.view.visible = false;
  }

  /** still — раунд под reduced motion: осколков и вспышек нет. */
  apply(scene: SceneState, grid: GridView, still: boolean): void {
    this.stars.visible = !still;
    if (still) {
      this.view.visible = false;
      return;
    }
    // Взрыва нет — контейнер частиц не рисуется вовсе: в покое он рвал бы батч сцены лишним draw-call.
    let exploding = false;
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      const progress = scene.explode[cell] ?? -1;
      const symbol = scene.symbol[cell] ?? EMPTY_CELL;
      const active = progress >= 0 && symbol !== EMPTY_CELL;
      const x = grid.centerX(cell);
      const y = grid.restY(cell) - (scene.offsetY[cell] ?? 0) * CELL;
      for (let k = 0; k < SHARDS_PER_SYMBOL; k++) {
        const slot = cell * SHARDS_PER_SYMBOL + k;
        const particle = this.#particles[slot];
        if (particle === undefined) continue;
        if (!active) {
          particle.alpha = 0;
          continue;
        }
        exploding = true;
        const texture = this.#textures[symbol * SHARDS_PER_SYMBOL + k];
        if (texture !== undefined && particle.texture !== texture) particle.texture = texture;
        const out = 1 - (1 - progress) * (1 - progress);
        particle.x = x + (this.#dirX[slot] ?? 0) * SPREAD * out;
        particle.y = y + (this.#dirY[slot] ?? 0) * SPREAD * out + DROP * progress * progress;
        particle.rotation = (k % 2 === 0 ? SPIN : -SPIN) * progress;
        particle.scaleX = 1 - 0.35 * progress;
        particle.scaleY = particle.scaleX;
        particle.alpha = 1 - progress * progress;
      }
      const flash = this.#flashes[cell];
      if (flash === undefined) continue;
      const share = progress / FLASH_SHARE;
      flash.visible = active && share < 1;
      if (!flash.visible) continue;
      flash.position.set(x, y);
      flash.scale.set(0.8 + FLASH_GROWTH * share);
      flash.alpha = 1 - share;
    }
    this.view.visible = exploding;
  }

  destroy(): void {
    this.view.destroy();
    this.stars.destroy({ children: true });
  }
}
