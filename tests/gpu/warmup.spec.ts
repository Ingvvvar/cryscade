import { expect, test, type Page } from '@playwright/test';
import type { ShownRound } from '../../src/client/index.ts';
import { FORCED_SEEDS } from '../../src/ui/forced-rounds.ts';
import { sceneInfo, waitSettled, type ProbeWindow } from '../support/page-probe.ts';
import { fixtureShown, seedShown } from '../support/shown-rounds.ts';
import { installPipelineCounter, type PipelineCounts } from './support/pipeline-counter.ts';
import { installTextureCounter, type TextureCounts } from './support/texture-counter.ts';

// Прогрев шейдеров (§10): после события «сцена готова» — первый видимый кадр и падение сетки — новых конвейеров
// (WebGPU) и программ (WebGL) нет. Контроль: ?warmup=off (только e2e-сборка) — первый кадр их создаёт.
// Фаза 5: и на кадрах каскада — подсветки (аддитивно), контуры, осколки и вспышки, числа множителей, плашки фичи,
// большой выигрыш: в момент init их на сцене нет, прогрев обязан собрать их конвейеры заранее.
// Правки фазы 5: и текстуры — первый кадр каждого уровня большого выигрыша и каждой плашки фичи не создаёт и не грузит
// ни одной текстуры (страницы глифов грузит прогрев), даже после двух минут без надписей: сборщик Pixi снял бы за это
// время страницу, которую не рисовали, — поэтому страницы ему не отданы.
// Фаза 7: и после смены языка — шрифт надписей сразу несёт строки обоих языков, английские надписи новых страниц глифов
// не создают (контроль — тот же тест без прогрева).

type CountWindow = ProbeWindow & { __pipelineCounts?: PipelineCounts; __textureCounts?: TextureCounts };

async function counts(page: Page): Promise<PipelineCounts> {
  const found = await page.evaluate(() => {
    const value = (window as CountWindow).__pipelineCounts;
    return value === undefined ? null : { ...value };
  });
  if (found === null) throw new Error('счётчик конвейеров не установлен');
  return found;
}

/** Все сегменты раундов с каскадом, фичей и большим выигрышем — по кадру на середину, отрисовка сразу. */
async function playCascadeFrames(page: Page): Promise<number> {
  let frames = 0;
  for (const name of ['multiplier-8', 'feature-start'] as const) {
    frames += await page.evaluate((round) => {
      const probe = (window as ProbeWindow).__cryscadeProbe;
      probe?.still(round, 0);
      const segments = probe?.schedule()?.segments ?? [];
      let rendered = 0;
      for (const segment of segments) {
        if (segment.endMs <= segment.startMs) continue;
        probe?.still(round, Math.floor((segment.startMs + segment.endMs) / 2));
        probe?.renderOnce();
        rendered += 1;
      }
      return rendered;
    }, fixtureShown(name));
  }
  return frames;
}

for (const renderer of ['webgl', 'webgpu'] as const) {
  for (const warm of [true, false]) {
    test(`${renderer}: ${warm ? 'после прогрева кадры не создают конвейеров' : 'без прогрева (контроль) — создают'}`, async ({ page }) => {
      await page.addInitScript(installPipelineCounter);
      await page.goto(`./?renderer=${renderer}${warm ? '' : '&warmup=off'}`);
      await waitSettled(page);
      await page.waitForTimeout(300);
      const settled = await counts(page);
      console.log(`${renderer}, прогрев ${warm ? 'есть' : 'нет'}: до готовности ${String(settled.atReady)}, всего ${String(settled.total)}`);
      expect(settled.readySeen, 'событие готовности сцены').toBe(true);
      expect(settled.atReady, 'счётчик видит создание конвейеров').toBeGreaterThan(0);
      if (warm) expect(settled.total - settled.atReady).toBe(0);
      else expect(settled.total - settled.atReady).toBeGreaterThan(0);
    });
  }

  for (const warm of [true, false]) {
    test(`${renderer}: кадры каскада, фичи и большого выигрыша — ${warm ? 'после прогрева без новых конвейеров' : 'без прогрева (контроль) — с новыми'}`, async ({ page }) => {
      await page.addInitScript(installPipelineCounter);
      await page.goto(`./?renderer=${renderer}${warm ? '' : '&warmup=off'}`);
      await waitSettled(page);
      await page.evaluate(() => {
        (window as ProbeWindow).__cryscadeProbe?.stopTicker();
      });
      const before = await counts(page);
      const frames = await playCascadeFrames(page);
      const after = await counts(page);
      console.log(`${renderer}, прогрев ${warm ? 'есть' : 'нет'}: кадров каскада ${String(frames)}, новых конвейеров ${String(after.total - before.total)}, с начала после готовности ${String(after.total - after.atReady)}`);
      expect(frames, 'кадры нашлись').toBeGreaterThan(50);
      if (warm) expect(after.total - after.atReady, 'после готовности конвейеров не прибавилось').toBe(0);
      else expect(after.total - after.atReady, 'контроль: без прогрева конвейеры собираются в кадрах').toBeGreaterThan(0);
    });
  }
}

/** Первый кадр надписи: сегмент, с которого она появляется, в группе своего вида; кадр — первый кадр 60 Гц после старта. */
interface FirstFrame {
  readonly name: string;
  readonly round: ShownRound;
  readonly segment: string;
  readonly group: string;
  /** Надпись плашки, которую зонд видит на этом кадре; большой выигрыш — null. */
  readonly plaque: string | null;
  /** Она же по-английски. */
  readonly plaqueEn: string | null;
}

const FIRST_FRAMES: readonly FirstFrame[] = [
  { name: 'Великий виграш', round: seedShown(FORCED_SEEDS.bigWin1), segment: 'celebrate', group: 'bigWin', plaque: null, plaqueEn: null },
  { name: 'Величезний виграш', round: seedShown(FORCED_SEEDS.bigWin2), segment: 'celebrate', group: 'bigWin', plaque: null, plaqueEn: null },
  { name: 'Епічний виграш', round: seedShown(FORCED_SEEDS.bigWin3), segment: 'celebrate', group: 'bigWin', plaque: null, plaqueEn: null },
  { name: 'Максимальний виграш', round: seedShown(FORCED_SEEDS.maxWin), segment: 'celebrate', group: 'bigWin', plaque: null, plaqueEn: null },
  { name: 'плашка фріспінів', round: fixtureShown('feature-start'), segment: 'plaqueIn', group: 'feature', plaque: 'Фріспіни', plaqueEn: 'Free spins' },
  { name: 'плашка ретриггера', round: fixtureShown('retrigger'), segment: 'plaqueIn', group: 'retrigger', plaque: '+5 фріспінів', plaqueEn: '+5 free spins' },
  { name: 'плашка капа', round: fixtureShown('biggest'), segment: 'cap', group: 'cascade', plaque: 'Максимальний виграш', plaqueEn: 'Maximum win' },
];

/** Английский — как игрок: меню, «Налаштування», English, Esc. */
async function toEnglish(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Налаштування' }).click();
  await page.getByRole('radio', { name: 'English' }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Spin' })).toBeVisible();
}

interface FrameUse extends TextureCounts {
  readonly name: string;
  readonly t: number;
  readonly plaque: string | null;
}

/** Первый кадр надписи — одна отрисовка при остановленном тикере; что за неё создано и загружено. */
async function firstFrame(page: Page, frame: FirstFrame): Promise<FrameUse> {
  const use = await page.evaluate(({ round, segment, group }) => {
    const w = window as CountWindow;
    const probe = w.__cryscadeProbe;
    const counts = w.__textureCounts;
    if (probe === undefined || counts === undefined) throw new Error('нет зонда или счётчика текстур');
    probe.still(round, 0);
    const schedule = probe.schedule();
    const target = schedule?.segments.find((item) => item.kind === segment && schedule.groups[item.group]?.kind === group);
    if (target === undefined) return null;
    const t = target.startMs + 16;
    counts.created = 0;
    counts.uploaded = 0;
    counts.mipmaps = 0;
    probe.still(round, t);
    probe.renderOnce();
    return { t, created: counts.created, uploaded: counts.uploaded, mipmaps: counts.mipmaps, plaque: probe.plaqueText() };
  }, frame);
  if (use === null) throw new Error(`${frame.name}: сегмента ${frame.segment} в группе ${frame.group} нет`);
  return { name: frame.name, ...use };
}

for (const renderer of ['webgl', 'webgpu'] as const) {
  for (const [warm, english] of [
    [true, false],
    [true, true],
    [false, false],
  ] as const) {
    const title = warm ? `ни одной новой текстуры${english ? ' — и по-английски после смены языка' : ''}` : 'без прогрева (контроль) — с загрузкой';
    test(`${renderer}: первый кадр надписей после двух минут покоя — ${title}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.addInitScript(installTextureCounter);
      await page.clock.install({ time: 0 });
      await page.goto(`./?renderer=${renderer}${warm ? '' : '&warmup=off'}`);
      await waitSettled(page);
      if (english) await toEnglish(page);
      const info = await sceneInfo(page);
      expect(info.name).toBe(renderer);
      expect(info.software, `программный рендер: ${info.gpu}`).toBe(false);
      // Покой без надписей: сборщик Pixi (раз в 30 с) снимает то, что не рисовали дольше минуты.
      await page.clock.runFor(125_000);
      await page.evaluate(() => {
        (window as ProbeWindow).__cryscadeProbe?.stopTicker();
      });
      const rows: FrameUse[] = [];
      for (const frame of FIRST_FRAMES) rows.push(await firstFrame(page, frame));
      console.log(
        `${renderer}, прогрев ${warm ? 'есть' : 'нет'} (${info.gpu}):\n${rows.map((row) => `  ${row.name}, t = ${String(row.t)}: создано ${String(row.created)}, загружено ${String(row.uploaded)}, мипмапов ${String(row.mipmaps)}`).join('\n')}`,
      );
      expect(rows.map((row) => row.plaque), 'кадр показывает свою плашку').toStrictEqual(FIRST_FRAMES.map((frame) => (english ? frame.plaqueEn : frame.plaque)));
      if (warm) {
        for (const row of rows) expect([row.created, row.uploaded, row.mipmaps], `${row.name}: текстур не создано и не загружено`).toStrictEqual([0, 0, 0]);
      } else {
        const loads = rows.reduce((sum, row) => sum + row.created + row.uploaded, 0);
        expect(loads, 'контроль: без прогрева первый кадр надписи создаёт и грузит страницу глифов').toBeGreaterThan(0);
      }
    });
  }
}
