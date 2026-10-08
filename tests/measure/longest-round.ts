import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { PRESETS } from '../../src/core/jurisdiction.ts';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import { buildSchedule } from '../../src/core/presentation/index.ts';
import { decodeBook } from '../../src/server/book.ts';
import { SERVER_MAX_REQUESTS } from '../../src/server/limits.ts';
import { SeededRounds } from '../../src/server/seeded-rounds.ts';
import { BOOK_DIR, findBook } from '../../tools/books/files.ts';

// Самый длинный раунд книги — по шагам каскада в расписании: контуры держат по GraphicsContext на шаг и пул только
// растёт до высшей отметки (render/pixi/contour-view.ts). Прогрев замера памяти начинается с него — к отметке 50 пул на
// верху, и раунд книги между 50-м и 300-м новых контекстов не прибавит. Без него (проба по книге): у остальных раундов
// прогрева до 18 шагов, в книге — до 31; раунд длиннее 18 шагов выпадает с долей 1.9e-5 на спин, за 250 спинов — 0.48%,
// и проверка живых GraphicsContext покраснела бы на честном росте пула. Тот же движок и то же расписание, что у игры.

export interface LongestRound {
  readonly seed: number;
  readonly steps: number;
}

export function longestBookRound(): LongestRound {
  const read = decodeBook(new Uint8Array(gunzipSync(readFileSync(`${BOOK_DIR}/${findBook()}`))), DEFAULT_CONFIG.capX100);
  if (!read.ok) throw new Error(read.problem);
  const rounds = new SeededRounds(DEFAULT_CONFIG, SERVER_MAX_REQUESTS);
  const options = { speed: 'turbo', preset: PRESETS.standard, reducedMotion: false } as const;
  let longest: LongestRound = { seed: -1, steps: -1 };
  for (let index = 0; index < read.book.size; index++) {
    const { seed } = read.book.record(index);
    const played = rounds.play(seed);
    const { steps } = buildSchedule({ events: played.events, betMinor: 100, winMinor: played.payX100, previousGrid: null }, options);
    if (steps.length > longest.steps) longest = { seed, steps: steps.length };
  }
  return longest;
}
