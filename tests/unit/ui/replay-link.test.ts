import { describe, expect, it } from 'vitest';
import { replayExit, replayTarget } from '../../../src/ui/replay-link.ts';

// Ссылка повтора: ?replay=round:<id> — id раунда в формате протокола (1–64 знака [0-9A-Za-z_-]), ?replay=book:<index> —
// индекс книги 0…79 999 без ведущих нулей. Всё прочее — не повтор, а обычный запуск.

describe('replayTarget', () => {
  it.each([
    ['?replay=round:ar1', { round: 'ar1' }],
    ['?replay=round:Ab_9-z', { round: 'Ab_9-z' }],
    [`?replay=round:${'x'.repeat(64)}`, { round: 'x'.repeat(64) }],
    ['?replay=round%3Ar1', { round: 'r1' }],
    ['?autoskip=1&replay=round:r1', { round: 'r1' }],
    ['?replay=round:r1&replay=book:5', { round: 'r1' }],
    ['?replay=book:0', { book: 0 }],
    ['?replay=book:7', { book: 7 }],
    ['?replay=book:58353', { book: 58_353 }],
    ['?replay=book:79999', { book: 79_999 }],
  ] as const)('%s → повтор', (search, target) => {
    expect(replayTarget(search)).toStrictEqual(target);
  });

  it.each([
    '',
    '?autoskip=1',
    '?replay=',
    '?replay=round:',
    `?replay=round:${'x'.repeat(65)}`,
    '?replay=round:a:b',
    '?replay=round:a.b',
    '?replay=round:%D0%B6',
    '?replay=Round:r1',
    '?replay=r1',
    '?replay=book:',
    '?replay=book:80000',
    '?replay=book:99999',
    '?replay=book:100000',
    '?replay=book:01',
    '?replay=book:-1',
    '?replay=book:1.5',
    '?replay=book:1e3',
    '?replay=book: 1',
    '?replay=book:0x10',
  ])('%s → обычный запуск', (search) => {
    expect(replayTarget(search)).toBeNull();
  });
});

describe('replayExit', () => {
  it.each([
    ['http://localhost:4173/cryscade/?replay=book:5', 'http://localhost:4173/cryscade/'],
    ['http://localhost:4173/cryscade/?replay=book:5&autoskip=1', 'http://localhost:4173/cryscade/?autoskip=1'],
    ['https://example.github.io/cryscade/?autoskip=1&replay=round:r1#top', 'https://example.github.io/cryscade/?autoskip=1#top'],
    ['https://example.github.io/cryscade/?replay=round:r1&replay=book:2', 'https://example.github.io/cryscade/'],
  ])('%s → %s', (href, exit) => {
    expect(replayExit(href)).toBe(exit);
  });
});
