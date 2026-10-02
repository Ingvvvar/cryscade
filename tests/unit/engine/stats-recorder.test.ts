import { describe, expect, it } from 'vitest';
import { CASCADE_SLOTS, RoundEngine, StatsRecorder, type ClusterView } from '../../../src/core/engine/index.ts';
import type { GameConfig } from '../../../src/core/model/config.ts';
import { TEST_CONFIG, withCap } from '../../support/configs.ts';
import { BACKGROUND, ScenarioSource, deadSpins, drops, fill, type ScenarioStep } from '../../support/scenario.ts';

// Факты StatsRecorder на литеральных сценариях фазы 1: ожидания — из тех же ручных расчётов.

const COLUMN_FILL = ['QACESRQ', 'CESRQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ'];
const COLUMN_DROPS = ['...R...', '...A...', '...E...', '...R...', '...A...', '.......', '.......'];
const DIAMOND = 6;

function statsOf(config: GameConfig, steps: readonly ScenarioStep[]): StatsRecorder {
  const stats = new StatsRecorder(config);
  const source = new ScenarioSource(steps);
  new RoundEngine(config, source, stats).play();
  expect(source.remaining).toBe(0);
  return stats;
}

function facts(stats: StatsRecorder): Record<string, number | boolean> {
  return {
    payX100: stats.payX100,
    basePayX100: stats.basePayX100,
    featurePayX100: stats.featurePayX100,
    featured: stats.featured,
    awardedSpins: stats.awardedSpins,
    freeSpins: stats.freeSpins,
    retriggers: stats.retriggers,
    capped: stats.capped,
    cascadeSteps: stats.cascadeSteps,
    longestCascade: stats.longestCascade,
    maxClusterMult: stats.maxClusterMult,
    maxLevel: stats.maxLevel,
  };
}

/** Непустые клетки использования: «фаза символ полоса» → [Σ множителей, кластеров]. */
function usageOf(stats: StatsRecorder): Record<string, [number, number]> {
  const usage = new Float64Array(2 * 7 * stats.bands);
  const clusters = new Float64Array(2 * 7 * stats.bands);
  stats.addUsageTo(usage, clusters);
  const cells: Record<string, [number, number]> = {};
  usage.forEach((mult, index) => {
    if (mult === 0) return;
    const band = index % stats.bands;
    const symbol = Math.floor(index / stats.bands) % 7;
    const phase = Math.floor(index / (7 * stats.bands));
    cells[`${String(phase)} ${String(symbol)} ${String(band)}`] = [mult, clusters[index] ?? 0];
  });
  return cells;
}

interface Priced {
  readonly symbol: number;
  readonly size: number;
  readonly mult: number;
  readonly payX100: number;
}

/**
 * Вид кластеров шага напрямую: count первых — кластеры шага, за ними — хвост прошлого шага (ClusterTable при clear
 * обнуляет только счёт, буферы не стирает).
 */
function clustersView(list: readonly Priced[]): ClusterView {
  const tail: Priced = { symbol: 1, size: 9, mult: 64, payX100: 999 };
  const at = (cluster: number): Priced => list[cluster] ?? tail;
  return {
    count: list.length,
    symbol: (cluster) => at(cluster).symbol,
    size: (cluster) => at(cluster).size,
    cellAt: () => 0,
    mult: (cluster) => at(cluster).mult,
    payX100: (cluster) => at(cluster).payX100,
  };
}

function cascadesOf(stats: StatsRecorder): Record<string, number> {
  const target = new Float64Array(2 * CASCADE_SLOTS);
  stats.addCascadesTo(target);
  const spins: Record<string, number> = {};
  target.forEach((count, index) => {
    if (count > 0) spins[`${index < CASCADE_SLOTS ? 'base' : 'free'} ${String(index % CASCADE_SLOTS)}`] = count;
  });
  return spins;
}

describe('StatsRecorder на литеральных сценариях', () => {
  it('кластер из 5', () => {
    const stats = statsOf(TEST_CONFIG, [fill('base', COLUMN_FILL), drops('base', COLUMN_DROPS)]);
    expect(facts(stats)).toStrictEqual({
      payX100: 100,
      basePayX100: 100,
      featurePayX100: 0,
      featured: false,
      awardedSpins: 0,
      freeSpins: 0,
      retriggers: 0,
      capped: false,
      cascadeSteps: 1,
      longestCascade: 1,
      maxClusterMult: 1,
      maxLevel: 1,
    });
    expect(usageOf(stats)).toStrictEqual({ [`0 ${String(DIAMOND)} 0`]: [1, 1] });
    expect(cascadesOf(stats)).toStrictEqual({ 'base 1': 1 });
  });

  it('сумма множителей: четыре шага, ×1, ×1, ×6, ×16 — и выплата равна Σ таблица × использование', () => {
    const top = drops('base', ['...D...', '...D...', '...D...', '...D...', '...D...', '.......', '.......']);
    const stats = statsOf(TEST_CONFIG, [
      fill('base', ['QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ']),
      drops('base', ['...E...', '...R...', '...D...', '...D...', '...D...', '...D...', '...D...']),
      top,
      top,
      drops('base', COLUMN_DROPS),
    ]);
    expect(facts(stats)).toMatchObject({ payX100: 2550, cascadeSteps: 4, longestCascade: 4, maxClusterMult: 16, maxLevel: 4 });
    // Кластер из 7 (полоса 7–8) — ×1; три кластера из 5 (полоса 5–6) — ×1 + ×6 + ×16.
    expect(usageOf(stats)).toStrictEqual({ [`0 ${String(DIAMOND)} 0`]: [23, 3], [`0 ${String(DIAMOND)} 1`]: [1, 1] });
    expect(100 * 23 + 250 * 1).toBe(stats.payX100);
    expect(cascadesOf(stats)).toStrictEqual({ 'base 4': 1 });
  });

  it('фича: выплаты основной игры и фичи порознь, спины по длине каскада', () => {
    const column = [fill('free', COLUMN_FILL), drops('free', COLUMN_DROPS)];
    const stats = statsOf(TEST_CONFIG, [
      fill('base', ['*ACESR*', 'CESRQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSR*']),
      drops('base', COLUMN_DROPS),
      ...column,
      ...column,
      ...column,
      ...deadSpins(7),
    ]);
    expect(facts(stats)).toStrictEqual({
      payX100: 1300,
      basePayX100: 100,
      featurePayX100: 1200,
      featured: true,
      awardedSpins: 10,
      freeSpins: 10,
      retriggers: 0,
      capped: false,
      cascadeSteps: 4,
      longestCascade: 1,
      maxClusterMult: 10,
      maxLevel: 3,
    });
    expect(usageOf(stats)).toStrictEqual({ [`0 ${String(DIAMOND)} 0`]: [1, 1], [`1 ${String(DIAMOND)} 0`]: [12, 3] });
    expect(cascadesOf(stats)).toStrictEqual({ 'base 1': 1, 'free 0': 7, 'free 1': 3 });
  });

  it('ретриггеры и награда', () => {
    const stats = statsOf(TEST_CONFIG, [
      fill('base', [...BACKGROUND.slice(0, 6), '*AC*SR*']),
      ...deadSpins(2),
      fill('free', [...BACKGROUND.slice(0, 6), '*****RQ']),
      ...deadSpins(11),
      fill('free', [...BACKGROUND.slice(0, 6), '*AC*SR*']),
      ...deadSpins(5),
    ]);
    expect(facts(stats)).toMatchObject({ payX100: 0, featured: true, awardedSpins: 10, freeSpins: 20, retriggers: 2 });
  });

  it('кап на втором фриспине: обрезка — в фичу', () => {
    const stats = statsOf(withCap(150), [
      fill('base', [...BACKGROUND.slice(0, 6), '*AC*SR*']),
      fill('free', COLUMN_FILL),
      drops('free', COLUMN_DROPS),
      fill('free', COLUMN_FILL),
    ]);
    expect(facts(stats)).toMatchObject({ payX100: 150, basePayX100: 0, featurePayX100: 150, capped: true, freeSpins: 2 });
  });

  it('кап в основном спине: обрезка — в основную игру, фичи нет', () => {
    const stats = statsOf(withCap(80), [fill('base', ['*ACESR*', 'CESRQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSR*'])]);
    expect(facts(stats)).toMatchObject({ payX100: 80, basePayX100: 80, featurePayX100: 0, capped: true, featured: false });
  });

  it('пустой список полос — RangeError', () => {
    expect(() => new StatsRecorder({ sizeBands: [] })).toThrow(RangeError);
    expect(() => new StatsRecorder({ sizeBands: [] })).toThrow('sizeBands: пустой список полос');
  });

  // Прямые вызовы записывающего интерфейса: размеры и хвосты, до которых сценарии фазы 1 не доходят.
  it('кластеры на 48 и 49 клеток — в последней полосе; хвост таблицы за count не считается', () => {
    const stats = new StatsRecorder(TEST_CONFIG);
    stats.begin();
    stats.fill();
    stats.win(clustersView([{ symbol: 4, size: 49, mult: 1, payX100: 600 }, { symbol: 2, size: 48, mult: 2, payX100: 1200 }]));
    stats.end(1800);
    expect(usageOf(stats)).toStrictEqual({ '0 2 5': [2, 1], '0 4 5': [1, 1] });
    expect(stats.maxClusterMult).toBe(2);
  });

  it('addUsageTo и addCascadesTo прибавляют к накопленному, а не перезаписывают', () => {
    const stats = statsOf(TEST_CONFIG, [fill('base', COLUMN_FILL), drops('base', COLUMN_DROPS)]);
    const usage = new Float64Array(2 * 7 * stats.bands);
    const clusters = new Float64Array(2 * 7 * stats.bands);
    const cascades = new Float64Array(2 * CASCADE_SLOTS);
    stats.addUsageTo(usage, clusters);
    stats.addUsageTo(usage, clusters);
    stats.addCascadesTo(cascades);
    stats.addCascadesTo(cascades);
    const at = DIAMOND * stats.bands;
    expect([usage[at], clusters[at], cascades[1]]).toStrictEqual([2, 2, 2]);
  });

  it('кап во фриспинах после выигрыша основной игры: фича — кап минус основная', () => {
    const stats = new StatsRecorder(TEST_CONFIG);
    stats.begin();
    stats.fill();
    stats.win(clustersView([{ symbol: 6, size: 5, mult: 1, payX100: 300 }]));
    stats.fsStart(10);
    stats.fsSpin();
    stats.fill();
    stats.win(clustersView([{ symbol: 6, size: 15, mult: 16, payX100: 160_000 }]));
    stats.cap();
    stats.end(1000);
    expect(facts(stats)).toMatchObject({ payX100: 1000, basePayX100: 300, featurePayX100: 700, capped: true });
  });

  it('каскад длиннее 63 шагов — в последнем слоте основной игры', () => {
    const stats = new StatsRecorder(TEST_CONFIG);
    stats.begin();
    stats.fill();
    for (let step = 0; step < 70; step++) stats.win(clustersView([]));
    stats.end(0);
    expect(cascadesOf(stats)).toStrictEqual({ 'base 63': 1 });
    expect(stats.longestCascade).toBe(70);
  });

  it('следующий раунд начинается с нуля', () => {
    const stats = new StatsRecorder(TEST_CONFIG);
    const round = [fill('base', COLUMN_FILL), drops('base', COLUMN_DROPS)];
    const engine = new RoundEngine(TEST_CONFIG, new ScenarioSource([...round, ...round]), stats);
    engine.play();
    engine.play();
    expect(usageOf(stats)).toStrictEqual({ [`0 ${String(DIAMOND)} 0`]: [1, 1] });
    expect(cascadesOf(stats)).toStrictEqual({ 'base 1': 1 });
    expect(stats.cascadeSteps).toBe(1);
  });
});
