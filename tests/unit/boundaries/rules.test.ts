import { describe, expect, it } from 'vitest';
import { checkEdge, forbiddenReach, moduleOf, type Target } from './graph.ts';

const file = (path: string): Target => ({ kind: 'file', path });
const pkg = (name: string): Target => ({ kind: 'package', name });

describe('moduleOf', () => {
  it.each([
    ['src/core/model/symbols.ts', 'core/model'],
    ['src/core/rng/xoshiro.ts', 'core/rng'],
    ['src/core/engine/grid.ts', 'core/engine'],
    ['src/core/presentation/schedule.ts', 'core/presentation'],
    ['src/core/fsm/machine.ts', 'core/fsm'],
    ['src/core/money.ts', 'core/money'],
    ['src/core/jurisdiction.ts', 'core/jurisdiction'],
    ['src/core/probe.ts', 'core/other'],
    ['src/protocol/messages.ts', 'protocol'],
    ['src/server/worker.ts', 'server'],
    ['src/client/controller.ts', 'client'],
    ['src/render/pixi/grid.ts', 'render/pixi'],
    ['src/render/layout.ts', 'render'],
    ['src/render/art/facets.ts', 'render'],
    ['src/ui/App.tsx', 'ui'],
    ['src/audio/synth.ts', 'audio'],
    ['tools/hello.ts', 'tools'],
    ['src/stray.ts', null],
    ['src/misc/helper.ts', null],
    ['tests/unit/x.test.ts', null],
    ['fixtures/rounds/loss.json', 'fixtures'],
    ['fixtures/rounds/loss.ts', null],
    ['fixtures/other.json', null],
  ])('%s → %s', (path, expected) => {
    expect(moduleOf(path)).toBe(expected);
  });
});

// Каждая строка таблицы §3: что можно и что нельзя. true — ребро разрешено.
const EDGES: [string, Target, boolean][] = [
  // core/** → только core/**
  ['src/core/engine/a.ts', file('src/core/rng/b.ts'), true],
  ['src/core/engine/a.ts', file('src/core/model/b.ts'), true],
  ['src/core/rng/a.ts', file('src/core/engine/b.ts'), true],
  ['src/core/probe.ts', file('src/core/engine/b.ts'), true],
  ['src/core/engine/a.ts', file('src/protocol/b.ts'), false],
  ['src/core/engine/a.ts', file('src/server/b.ts'), false],
  ['src/core/model/a.ts', file('tools/b.ts'), false],
  ['src/core/engine/a.ts', pkg('pixi.js'), false],
  ['src/core/model/a.ts', pkg('node:crypto'), false],
  // внутри core: model, money, jurisdiction, fsm, presentation не импортируют engine и rng
  ['src/core/model/a.ts', file('src/core/engine/b.ts'), false],
  ['src/core/model/a.ts', file('src/core/rng/b.ts'), false],
  ['src/core/money.ts', file('src/core/engine/b.ts'), false],
  ['src/core/money.ts', file('src/core/rng/b.ts'), false],
  ['src/core/jurisdiction.ts', file('src/core/engine/b.ts'), false],
  ['src/core/jurisdiction.ts', file('src/core/rng/b.ts'), false],
  ['src/core/fsm/a.ts', file('src/core/engine/b.ts'), false],
  ['src/core/fsm/a.ts', file('src/core/rng/b.ts'), false],
  ['src/core/presentation/a.ts', file('src/core/engine/b.ts'), false],
  ['src/core/presentation/a.ts', file('src/core/rng/b.ts'), false],
  ['src/core/presentation/a.ts', file('src/core/model/b.ts'), true],
  ['src/core/presentation/a.ts', file('src/core/probe.ts'), true],
  // protocol/** → core/model
  ['src/protocol/a.ts', file('src/core/model/b.ts'), true],
  ['src/protocol/a.ts', file('src/protocol/b.ts'), true],
  ['src/protocol/a.ts', file('src/core/engine/b.ts'), false],
  ['src/protocol/a.ts', file('src/core/fsm/b.ts'), false],
  ['src/protocol/a.ts', file('src/core/money.ts'), false],
  ['src/protocol/a.ts', file('src/server/b.ts'), false],
  ['src/protocol/a.ts', pkg('react'), false],
  // server/** → core/**, protocol/**
  ['src/server/a.ts', file('src/core/engine/b.ts'), true],
  ['src/server/a.ts', file('src/core/rng/b.ts'), true],
  ['src/server/a.ts', file('src/protocol/b.ts'), true],
  ['src/server/worker.ts', file('src/server/wallet.ts'), true],
  ['src/server/a.ts', file('src/client/b.ts'), false],
  ['src/server/a.ts', file('src/ui/b.tsx'), false],
  ['src/server/a.ts', file('src/render/pixi/b.ts'), false],
  ['src/server/a.ts', file('src/audio/b.ts'), false],
  ['src/server/a.ts', pkg('react'), false],
  ['src/server/a.ts', pkg('pixi.js'), false],
  // client/** → core/{model,fsm,presentation,jurisdiction,money}, protocol/**
  ['src/client/a.ts', file('src/core/model/b.ts'), true],
  ['src/client/a.ts', file('src/core/fsm/b.ts'), true],
  ['src/client/a.ts', file('src/core/presentation/b.ts'), true],
  ['src/client/a.ts', file('src/core/jurisdiction.ts'), true],
  ['src/client/a.ts', file('src/core/money.ts'), true],
  ['src/client/a.ts', file('src/protocol/b.ts'), true],
  ['src/client/a.ts', file('src/core/engine/b.ts'), false],
  ['src/client/a.ts', file('src/core/rng/b.ts'), false],
  ['src/client/a.ts', file('src/core/probe.ts'), false],
  ['src/client/a.ts', file('src/server/b.ts'), false],
  ['src/client/a.ts', pkg('react'), false],
  ['src/client/a.ts', pkg('pixi.js'), false],
  // render/ вне render/pixi/ → render/ без pixi, core/model, core/presentation; пакетов нет
  ['src/render/a.ts', file('src/render/art/b.ts'), true],
  ['src/render/art/a.ts', file('src/render/b.ts'), true],
  ['src/render/a.ts', file('src/core/model/b.ts'), true],
  ['src/render/a.ts', file('src/core/presentation/b.ts'), true],
  ['src/render/a.ts', pkg('pixi.js'), false],
  ['src/render/art/a.ts', pkg('pixi.js'), false],
  ['src/render/a.ts', file('src/render/pixi/b.ts'), false],
  ['src/render/art/a.ts', file('src/render/pixi/b.ts'), false],
  ['src/render/a.ts', file('src/core/engine/b.ts'), false],
  ['src/render/a.ts', pkg('react'), false],
  // render/pixi/** → pixi.js, render/**, core/model, core/presentation
  ['src/render/pixi/a.ts', pkg('pixi.js'), true],
  ['src/render/pixi/a.ts', file('src/render/b.ts'), true],
  ['src/render/pixi/a.ts', file('src/render/art/b.ts'), true],
  ['src/render/pixi/a.ts', file('src/render/pixi/b.ts'), true],
  ['src/render/pixi/a.ts', file('src/core/model/b.ts'), true],
  ['src/render/pixi/a.ts', file('src/core/presentation/b.ts'), true],
  ['src/render/pixi/a.ts', file('src/core/engine/b.ts'), false],
  ['src/render/pixi/a.ts', file('src/core/rng/b.ts'), false],
  ['src/render/pixi/a.ts', file('src/server/b.ts'), false],
  ['src/render/pixi/a.ts', file('src/client/b.ts'), false],
  ['src/render/pixi/a.ts', pkg('react'), false],
  // ui/** → client/**, render/**, audio/**, core/model, protocol/**
  ['src/ui/a.tsx', file('src/client/b.ts'), true],
  ['src/ui/a.tsx', file('src/render/pixi/b.ts'), true],
  ['src/ui/a.tsx', file('src/render/b.ts'), true],
  ['src/ui/a.tsx', file('src/audio/b.ts'), true],
  ['src/ui/a.tsx', file('src/core/model/b.ts'), true],
  ['src/ui/a.tsx', file('src/protocol/b.ts'), true],
  ['src/ui/a.tsx', pkg('react'), true],
  ['src/ui/a.tsx', pkg('react-dom'), true],
  ['src/ui/a.tsx', pkg('@fontsource-variable/unbounded'), true],
  ['src/ui/a.tsx', pkg('@fontsource-variable/manrope'), true],
  ['src/ui/a.tsx', file('src/core/engine/b.ts'), false],
  ['src/ui/a.tsx', file('src/core/rng/b.ts'), false],
  ['src/ui/a.tsx', file('src/server/b.ts'), false],
  ['src/ui/a.tsx', pkg('pixi.js'), false],
  // fixtures/rounds/*.json — только ui/, временно до фазы 4
  ['src/ui/main.tsx', file('fixtures/rounds/feature-start.json'), true],
  ['src/ui/a.tsx', file('fixtures/other.json'), false],
  ['src/render/pixi/a.ts', file('fixtures/rounds/a.json'), false],
  ['src/render/a.ts', file('fixtures/rounds/a.json'), false],
  ['src/client/a.ts', file('fixtures/rounds/a.json'), false],
  ['src/core/model/a.ts', file('fixtures/rounds/a.json'), false],
  ['src/server/a.ts', file('fixtures/rounds/a.json'), false],
  ['tools/a.ts', file('fixtures/rounds/a.json'), false],
  // audio/** → core/model, core/presentation
  ['src/audio/a.ts', file('src/core/model/b.ts'), true],
  ['src/audio/a.ts', file('src/core/presentation/b.ts'), true],
  ['src/audio/a.ts', file('src/core/engine/b.ts'), false],
  ['src/audio/a.ts', file('src/server/b.ts'), false],
  ['src/audio/a.ts', pkg('react'), false],
  ['src/audio/a.ts', pkg('pixi.js'), false],
  // tools/** → core/**, server/**
  ['tools/a.ts', file('src/core/engine/b.ts'), true],
  ['tools/a.ts', file('src/server/b.ts'), true],
  ['tools/a.ts', pkg('node:worker_threads'), true],
  ['tools/a.ts', file('src/client/b.ts'), false],
  ['tools/a.ts', file('src/ui/b.tsx'), false],
  ['tools/a.ts', file('src/render/pixi/b.ts'), false],
  ['tools/a.ts', file('src/render/b.ts'), false],
  ['tools/a.ts', file('src/audio/b.ts'), false],
  // файл вне модулей — нарушение с обеих сторон; непроверяемый импорт — нарушение
  ['src/stray.ts', file('src/core/model/b.ts'), false],
  ['src/ui/a.tsx', file('src/stray.ts'), false],
  ['src/ui/a.tsx', { kind: 'unresolved', specifier: null }, false],
];

const label = (target: Target): string =>
  target.kind === 'file' ? target.path : target.kind === 'package' ? `пакет ${target.name}` : 'непроверяемый импорт';

describe('checkEdge по таблице §3', () => {
  it.each(EDGES.map(([from, target, allowed]) => [from, label(target), allowed, target] as const))(
    '%s → %s: %s',
    (from, _label, allowed, target) => {
      expect(checkEdge(from, target) === null).toBe(allowed);
    },
  );
});

describe('forbiddenReach', () => {
  it('ловит движок через посредника, хотя каждое ребро разрешено', () => {
    const graph = new Map([
      ['src/client/a.ts', ['src/core/presentation/p.ts']],
      ['src/core/presentation/p.ts', ['src/core/probe.ts']],
      ['src/core/probe.ts', ['src/core/engine/e.ts']],
      ['src/core/engine/e.ts', []],
    ]);
    for (const [from, targets] of graph) {
      for (const to of targets) expect(checkEdge(from, file(to))).toBeNull();
    }
    expect(forbiddenReach(graph)).toEqual([
      'src/client/a.ts → src/core/presentation/p.ts → src/core/probe.ts → src/core/engine/e.ts',
    ]);
  });

  it('ловит rng и server/ из render/, ui/, audio/', () => {
    const graph = new Map([
      ['src/render/pixi/a.ts', ['src/core/probe.ts']],
      ['src/ui/a.tsx', ['src/core/probe.ts']],
      ['src/audio/a.ts', ['src/core/probe.ts']],
      ['src/core/probe.ts', ['src/core/rng/r.ts', 'src/server/s.ts']],
    ]);
    expect(forbiddenReach(graph)).toEqual([
      'src/render/pixi/a.ts → src/core/probe.ts → src/core/rng/r.ts',
      'src/render/pixi/a.ts → src/core/probe.ts → src/server/s.ts',
      'src/ui/a.tsx → src/core/probe.ts → src/core/rng/r.ts',
      'src/ui/a.tsx → src/core/probe.ts → src/server/s.ts',
      'src/audio/a.ts → src/core/probe.ts → src/core/rng/r.ts',
      'src/audio/a.ts → src/core/probe.ts → src/server/s.ts',
    ]);
  });

  it('сервер и инструменты движок видят', () => {
    const graph = new Map([
      ['src/server/a.ts', ['src/core/engine/e.ts']],
      ['tools/a.ts', ['src/core/engine/e.ts']],
    ]);
    expect(forbiddenReach(graph)).toEqual([]);
  });
});
