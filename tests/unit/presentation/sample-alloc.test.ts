import { readFileSync } from 'node:fs';
import { GCProfiler } from 'node:v8';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../../src/core/jurisdiction.ts';
import { SceneState, buildSchedule, sampleScene, type Schedule } from '../../../src/core/presentation/index.ts';
import { scanAllocations } from '../engine/alloc-scan.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';

// sampleScene — горячий путь кадра (§13: аллокаций 0). По синтаксису: ни new, ни литералов, ни замыканий, ни
// итераторов в функциях sample-scene.ts. И замером: 200 000 кадров самого длинного раунда (кап, фича, ретриггер) —
// ни одной сборки молодого поколения; положительный контроль — тот же прогон с новым SceneState на кадр. Замер нашёл
// упаковку дробных чисел V8 на вызовах: поэтому времена расписания и t — целые миллисекунды.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const FILE = 'src/core/presentation/sample-scene.ts';

describe('sampleScene без аллокаций — по синтаксису', () => {
  const scan = scanAllocations(FILE, readFileSync(path.join(root, FILE), 'utf8'));

  it('скан видит весь путь кадра', () => {
    expect(scan.functions).toEqual(
      expect.arrayContaining(['sampleScene', 'groupAt', 'apply', 'resetMotion', 'clear', 'fall', 'highlight', 'explode', 'spots', 'refill', 'tally', 'scatters', 'plaque']),
    );
  });

  it('аллокаций нет', () => {
    expect(scan.findings.map((finding) => `${String(finding.line)} ${finding.owner} — ${finding.kind}`)).toStrictEqual([]);
  });
});

function biggest(): Schedule {
  const round = fixtureRound('biggest');
  return buildSchedule(
    { events: round.events, betMinor: 100, winMinor: round.payX100, previousGrid: null },
    { speed: 'normal', preset: PRESETS.standard, reducedMotion: false },
  );
}

/**
 * Сборки молодого поколения за frames кадров; кадры идут по всему раунду с шагом 17 мс — целые миллисекунды, как их
 * отдают часы показа. Прогрев — три прогона: JIT успевает встроить мелкие функции пути кадра.
 */
function youngCollections(schedule: Schedule, frames: number, frame: (t: number) => void): number {
  for (let run = 0; run < 3; run++) for (let k = 0; k < frames; k++) frame((k * 17) % schedule.durationMs);
  const profiler = new GCProfiler();
  profiler.start();
  for (let k = 0; k < frames; k++) frame((k * 17) % schedule.durationMs);
  const { statistics } = profiler.stop();
  return statistics.filter((gc) => gc.gcType === 'Scavenge' || gc.gcType === 'MinorMarkSweep').length;
}

describe('sampleScene без аллокаций — замером', () => {
  it('200 000 кадров — ноль сборок молодого поколения; с новым SceneState на кадр — сборки есть', () => {
    const schedule = biggest();
    const out = new SceneState();
    const quiet = youngCollections(schedule, 200_000, (t) => {
      sampleScene(schedule, t, out);
    });
    const control = youngCollections(schedule, 200_000, (t) => {
      sampleScene(schedule, t, new SceneState());
    });
    expect(control).toBeGreaterThan(0);
    expect(quiet).toBe(0);
  }, 60_000);
});
