import { describe, expect, it } from 'vitest';
import { CUE, buildCues, ducks, type CueKind, type CueTable } from '../../../src/audio/cues.ts';
import { PRESETS } from '../../../src/client/index.ts';
import { buildSchedule, type ScheduleOptions } from '../../../src/core/presentation/index.ts';
import { fixtureShown } from '../../support/shown-rounds.ts';
import type { FixtureName } from '../../support/fixture-rounds.ts';

// Сигналы звука раунда (§12, решение 2 фазы 8): из расписания показа фикстур на обычной скорости. Касание колонки —
// старт падения (220 мс после сброса прежней сетки) + колонка × 45 + 380 (FALL.normal); остальные — старт сегмента.

const NORMAL: ScheduleOptions = { speed: 'normal', preset: PRESETS.standard, reducedMotion: false };
const STRICT: ScheduleOptions = { speed: 'normal', preset: PRESETS.strict, reducedMotion: false };
const NAME: Readonly<Record<CueKind, string>> = {
  [CUE.land]: 'land',
  [CUE.core]: 'core',
  [CUE.spot]: 'spot',
  [CUE.cluster]: 'cluster',
  [CUE.win]: 'win',
  [CUE.cap]: 'cap',
  [CUE.retrigger]: 'retrigger',
  [CUE.featureStart]: 'featureStart',
  [CUE.bigWin]: 'bigWin',
};

function table(name: FixtureName, options: ScheduleOptions = NORMAL): CueTable {
  const round = fixtureShown(name);
  return buildCues(buildSchedule({ events: round.events, betMinor: round.betMinor, winMinor: round.winMinor, previousGrid: null }, options));
}

/** Сигналы таблицы строками «вид:значение@мс»; land — отдельно. */
function lines(cues: CueTable, lands: boolean): string[] {
  const out: string[] = [];
  for (let index = 0; index < cues.length; index++) {
    const kind = (cues.kinds[index] ?? 0) as CueKind;
    if ((kind === CUE.land) === lands) out.push(`${NAME[kind]}:${String(cues.values[index])}@${String(cues.times[index])}`);
  }
  return out;
}

describe('buildCues', () => {
  it('small-win: семь касаний колонок заполнения, касания досыпки, кластер каскада 0 и празднуемый подсчёт', () => {
    const cues = table('small-win');
    expect(lines(cues, true).slice(0, 7)).toStrictEqual(['land:0@600', 'land:1@645', 'land:2@690', 'land:3@735', 'land:4@780', 'land:5@825', 'land:6@870']);
    expect(lines(cues, true)).toHaveLength(10);
    expect(lines(cues, false)).toStrictEqual(['cluster:0@1074', 'win:0@2918']);
    expect([cues.warmFrom, cues.durationMs]).toStrictEqual([Number.POSITIVE_INFINITY, 3351]);
  });

  it('проигрыш — только касания колонок', () => {
    const cues = table('loss');
    expect([lines(cues, true).length, lines(cues, false)]).toStrictEqual([7, []]);
  });

  it('строгий пресет: выигрыш 0.95× ≤ ставки — без празднующего сигнала; 1.90× — с ним', () => {
    expect(lines(table('small-win', STRICT), false)).toStrictEqual(['cluster:0@1074']);
    expect(lines(table('base-win', STRICT), false)).toStrictEqual(['cluster:0@1074', 'win:0@2918']);
  });

  it('каскады спина: высота кластера растёт 0…4; удвоения множителя — уровни 2, 3, 4', () => {
    expect(lines(table('multiplier-8'), false)).toStrictEqual([
      'cluster:0@1074',
      'cluster:1@2918',
      'cluster:2@4762',
      'spot:2@5472',
      'cluster:3@6606',
      'spot:3@7316',
      'cluster:4@8450',
      'spot:4@9160',
      'win:0@10294',
    ]);
  });

  it('фича: ядра (3), старт фичи (10 фриспинов), тепло — со старта фичи; большой выигрыш уровня 1 с приседанием на празднование', () => {
    const cues = table('feature-start');
    const special = lines(cues, false).filter((line) => /^(core|featureStart|bigWin)/.test(line));
    expect(special).toStrictEqual(['core:3@1074', 'featureStart:10@1524', 'bigWin:1@29079']);
    expect(cues.warmFrom).toBe(1524);
    // Каскад считается заново в каждом фриспине: высота кластера — от его заполнения.
    expect(lines(cues, false).filter((line) => line.startsWith('cluster')).map((line) => line.split('@')[0])).toStrictEqual([
      'cluster:0',
      'cluster:0',
      'cluster:0',
      'cluster:0',
      'cluster:1',
      'cluster:0',
      'cluster:1',
    ]);
    const bigWin = [...cues.kinds].indexOf(CUE.bigWin);
    expect([cues.holds[bigWin], cues.holds[[...cues.kinds].indexOf(CUE.featureStart)]]).toStrictEqual([2600, 400]);
  });

  it('ретриггер — 4 ядра во фриспине и сигнал «+5»; кап и большой выигрыш уровня 4', () => {
    expect(lines(table('retrigger'), false).filter((line) => /^(core|retrigger)/.test(line))).toStrictEqual(['core:3@3351', 'core:4@18930', 'retrigger:5@19380']);
    expect(lines(table('biggest'), false).filter((line) => /^(cap|bigWin)/.test(line))).toStrictEqual(['cap:0@53804', 'bigWin:4@57204']);
  });

  it('таблица — по времени, без убывания', () => {
    for (const name of ['multiplier-8', 'feature-start', 'retrigger', 'biggest'] as const) {
      const cues = table(name);
      expect(cues.length).toBeGreaterThan(10);
      for (let index = 1; index < cues.length; index++) expect(cues.times[index]).toBeGreaterThanOrEqual(cues.times[index - 1] ?? 0);
    }
  });

  it('приседание фона — под выигрыш, кап, ретриггер, старт фичи и большой выигрыш; не под частые события', () => {
    expect(Object.values(CUE).map((kind) => [NAME[kind], ducks(kind)])).toStrictEqual([
      ['land', false],
      ['core', false],
      ['spot', false],
      ['cluster', false],
      ['win', true],
      ['cap', true],
      ['retrigger', true],
      ['featureStart', true],
      ['bigWin', true],
    ]);
  });
});
