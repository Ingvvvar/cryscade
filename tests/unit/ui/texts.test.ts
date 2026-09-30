import { describe, expect, it } from 'vitest';
import { SCENE_TEXT } from '../../../src/ui/texts.ts';

// Надпись ретриггера (§9): «+5 фріспінів» — число из fsRetrigger, форма слова — по правилам множини української.

describe('SCENE_TEXT.freeSpinsAdded', () => {
  it.each([
    [1, '+1 фріспін'],
    [2, '+2 фріспіни'],
    [4, '+4 фріспіни'],
    [5, '+5 фріспінів'],
    [11, '+11 фріспінів'],
    [12, '+12 фріспінів'],
    [21, '+21 фріспін'],
    [22, '+22 фріспіни'],
    [25, '+25 фріспінів'],
    [111, '+111 фріспінів'],
  ])('%i — «%s»', (count, text) => {
    expect(SCENE_TEXT.freeSpinsAdded(count)).toBe(text);
  });
});
