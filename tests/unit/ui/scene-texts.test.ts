import { describe, expect, it } from 'vitest';
import { sceneTextList } from '../../../src/render/renderer.ts';
import { SCENE_TEXTS } from '../../../src/ui/scene-texts.ts';

// Надписи сцены (§9, §11) на обоих языках: «+5 фріспінів» — число из fsRetrigger, форма слова — по правилам множины
// языка (украинский — one / few / many, английский — one / other).

describe('SCENE_TEXTS.uk.freeSpinsAdded', () => {
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
    expect(SCENE_TEXTS.uk.freeSpinsAdded(count)).toBe(text);
  });
});

describe('SCENE_TEXTS.en.freeSpinsAdded', () => {
  it.each([
    [0, '+0 free spins'],
    [1, '+1 free spin'],
    [2, '+2 free spins'],
    [5, '+5 free spins'],
    [11, '+11 free spins'],
    [21, '+21 free spins'],
  ])('%i — «%s»', (count, text) => {
    expect(SCENE_TEXTS.en.freeSpinsAdded(count)).toBe(text);
  });
});

describe('SCENE_TEXTS', () => {
  it('у обоих языков — те же надписи: строк поровну, ни одной пустой, ни одной общей', () => {
    const uk = sceneTextList(SCENE_TEXTS.uk);
    const en = sceneTextList(SCENE_TEXTS.en);
    expect(uk.length).toBeGreaterThan(0);
    expect(en).toHaveLength(uk.length);
    expect([...uk, ...en].filter((text) => text.trim() === '')).toStrictEqual([]);
    expect(uk.filter((text) => en.includes(text))).toStrictEqual([]);
  });

  it('английские надписи — литералами', () => {
    const { en } = SCENE_TEXTS;
    expect([en.freeSpins, en.tapToContinue, en.maxWin, ...en.bigWin]).toStrictEqual([
      'Free spins',
      'Tap to continue',
      'Maximum win',
      'Big win',
      'Huge win',
      'Epic win',
      'Maximum win',
    ]);
  });
});
