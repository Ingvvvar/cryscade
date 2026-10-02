import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanAllocations } from '../engine/alloc-scan.ts';

// Падение — горячий путь кадра (§13: аллокаций 0): скан текста src/core/presentation/fall.ts. Отдельным файлом, потому
// что мутационный прогон (vitest.mutation.config.ts) исключает тесты, которые читают текст мутируемых файлов.

describe('падение без аллокаций', () => {
  const file = 'src/core/presentation/fall.ts';
  const text = readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), 'utf8');
  const scan = scanAllocations(file, text);

  it('скан нашёл функции падения', () => {
    expect(scan.functions).toEqual(expect.arrayContaining(['fallHeight', 'settleMs', 'bounceCeiling', 'columnStartMs', 'gridSettleMs']));
  });

  it('аллокаций нет', () => {
    expect(scan.findings).toStrictEqual([]);
  });
});
