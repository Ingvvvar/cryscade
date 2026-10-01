// Надписи сцены Pixi (§9, §11) на обоих языках — в начальном JS: шрифт надписей ставится из строк всех языков сразу,
// поэтому смена языка не создаёт новых страниц глифов. В render/ текста нет — он получает их строками.

import type { SceneTexts } from '../render/renderer.ts';
import type { Language } from './i18n/dictionary.ts';

/** «Фріспін» при числе count — по правилам множини української (Intl.PluralRules): 1, 21 — фріспін; 2–4, 22–24 — фріспіни; 0, 5–20, 25 — фріспінів. */
function freeSpinsUk(count: number): string {
  switch (new Intl.PluralRules('uk-UA').select(count)) {
    case 'one':
      return 'фріспін';
    case 'few':
      return 'фріспіни';
    default:
      return 'фріспінів';
  }
}

/** «Free spin» при числе count: один — free spin, иначе — free spins (Intl.PluralRules en-GB). */
function freeSpinsEn(count: number): string {
  return new Intl.PluralRules('en-GB').select(count) === 'one' ? 'free spin' : 'free spins';
}

export const SCENE_TEXTS: Readonly<Record<Language, SceneTexts>> = {
  uk: {
    freeSpins: 'Фріспіни',
    freeSpinsAdded: (count) => `+${String(count)} ${freeSpinsUk(count)}`,
    tapToContinue: 'Натисніть, щоб продовжити',
    maxWin: 'Максимальний виграш',
    bigWin: ['Великий виграш', 'Величезний виграш', 'Епічний виграш', 'Максимальний виграш'],
  },
  en: {
    freeSpins: 'Free spins',
    freeSpinsAdded: (count) => `+${String(count)} ${freeSpinsEn(count)}`,
    tapToContinue: 'Tap to continue',
    maxWin: 'Maximum win',
    bigWin: ['Big win', 'Huge win', 'Epic win', 'Maximum win'],
  },
};
