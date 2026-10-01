import { describe, expect, it } from 'vitest';
import { CUE, buildCues, type CueKind } from '../../../src/audio/cues.ts';
import { SoundDirector, type Voice } from '../../../src/audio/director.ts';
import { PRESETS } from '../../../src/client/index.ts';
import { buildSchedule, type Schedule } from '../../../src/core/presentation/index.ts';
import { fixtureShown } from '../../support/shown-rounds.ts';
import type { FixtureName } from '../../support/fixture-rounds.ts';

// Директор звука (§12, решения 2, 3 и 5 фазы 8) на журнале вместо WebAudio: тикер — сигналы по одному в своё время;
// пропуск — между ними тишина, после — один старший; фон приседает только под выигрыш, фичу и большой выигрыш;
// тепло — во фриспинах; мьют и скрытая вкладка — голосу.

class LogVoice implements Voice {
  readonly log: string[] = [];

  play(kind: CueKind, value: number): void {
    this.log.push(`${String(kind)}:${String(value)}`);
  }

  duck(holdMs: number): void {
    this.log.push(`duck ${String(holdMs)}`);
  }

  setWarm(on: boolean): void {
    this.log.push(`warm ${String(on)}`);
  }

  setMuted(on: boolean): void {
    this.log.push(`muted ${String(on)}`);
  }

  setHidden(on: boolean): void {
    this.log.push(`hidden ${String(on)}`);
  }
}

function schedule(name: FixtureName): Schedule {
  const round = fixtureShown(name);
  return buildSchedule({ events: round.events, betMinor: round.betMinor, winMinor: round.winMinor, previousGrid: null }, { speed: 'normal', preset: PRESETS.standard, reducedMotion: false });
}

/** Часы тикером по 16 мс от from до конца. */
function play(director: SoundDirector, plan: Schedule, from = 0): void {
  for (let clock = from; clock < plan.durationMs; clock += 16) director.advanced(clock, Math.min(plan.durationMs, clock + 16), false);
}

describe('SoundDirector', () => {
  it('тикер: каждый сигнал таблицы — один раз, по порядку; выигрыш — с приседанием на длину подсчёта', () => {
    const plan = schedule('small-win');
    const voice = new LogVoice();
    const director = new SoundDirector(voice);
    director.started(plan, 0);
    play(director, plan);
    const cues = buildCues(plan);
    const expected: string[] = [];
    for (let index = 0; index < cues.length; index++) {
      expected.push(`${String(cues.kinds[index])}:${String(cues.values[index])}`);
      if (cues.kinds[index] === CUE.win) expected.push(`duck ${String(cues.holds[index])}`);
    }
    expect(voice.log).toStrictEqual(expected);
    expect(voice.log.filter((line) => line.startsWith('duck'))).toStrictEqual(['duck 433']);
  });

  it('пропуск: сигналы между молчат, после — один, старший из пропущенных; дальше — снова по одному', () => {
    const plan = schedule('multiplier-8');
    const voice = new LogVoice();
    const director = new SoundDirector(voice);
    director.started(plan, 0);
    director.advanced(0, 900, false);
    expect(voice.log).toHaveLength(7);
    voice.log.length = 0;
    // 900 → 5500: кластеры 0, 1, 2 и удвоение уровня 2 — звучит одно: кластер (старше удвоения) последнего каскада.
    director.advanced(900, 5500, true);
    expect(voice.log).toStrictEqual([`${String(CUE.cluster)}:0`]);
    voice.log.length = 0;
    director.advanced(5500, 6606, false);
    expect(voice.log.filter((line) => !line.startsWith(`${String(CUE.land)}:`))).toStrictEqual([`${String(CUE.cluster)}:3`]);
  });

  it('пропуск до конца с выигрышем — итог один: выигрыш с приседанием; пропуск без сигналов — тишина', () => {
    const plan = schedule('small-win');
    const voice = new LogVoice();
    const director = new SoundDirector(voice);
    director.started(plan, 0);
    director.advanced(0, 3351, true);
    expect(voice.log).toStrictEqual([`${String(CUE.win)}:0`, 'duck 433']);
    voice.log.length = 0;
    director.advanced(3351, 3351, true);
    expect(voice.log).toStrictEqual([]);
  });

  it('восстановленный раунд: сигналы до начала группы не звучат', () => {
    const plan = schedule('multiplier-8');
    const voice = new LogVoice();
    const director = new SoundDirector(voice);
    director.started(plan, 4762);
    play(director, plan, 4762);
    expect(voice.log.filter((line) => line.startsWith(`${String(CUE.cluster)}:`))).toStrictEqual(['3:2', '3:3', '3:4']);
  });

  it('тепло фриспинов: со старта фичи до конца раунда — по разу', () => {
    const plan = schedule('feature-start');
    const voice = new LogVoice();
    const director = new SoundDirector(voice);
    director.started(plan, 0);
    play(director, plan);
    expect(voice.log.filter((line) => line.startsWith('warm'))).toStrictEqual(['warm true', 'warm false']);
    const warm = voice.log.indexOf('warm true');
    expect(voice.log[warm - 2]).toBe(`${String(CUE.featureStart)}:10`);
  });

  it('восстановленный внутри фичи — тепло сразу; мьют и скрытая вкладка — голосу; без раунда — тишина', () => {
    const plan = schedule('feature-start');
    const voice = new LogVoice();
    const director = new SoundDirector(voice);
    director.advanced(0, 500, false);
    expect(voice.log).toStrictEqual([]);
    director.started(plan, 5000);
    director.setMuted(true);
    director.setHidden(true);
    expect(voice.log).toStrictEqual(['warm true', 'muted true', 'hidden true']);
  });
});
