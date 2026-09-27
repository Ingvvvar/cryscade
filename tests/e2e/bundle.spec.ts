import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Тестовые крючки только вне прод-сборки (§15, фаза 3). Сборки делает webServer этого конфига:
// dist/ — прод, dist-e2e/ — --mode e2e. Положительный контроль: те же маркеры находятся в dist-e2e/.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MARKERS = ['__cryscadeProbe', 'addControlSprites', 'removeControlSprites', 'renderOnce'];

function scripts(dir: string): { files: number; text: string } {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const full = path.join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|mjs|html)$/.test(entry)) out.push(readFileSync(full, 'utf8'));
    }
  };
  walk(path.join(ROOT, dir));
  return { files: out.length, text: out.join('\n') };
}

const count = (text: string, marker: string): number => text.split(marker).length - 1;

test('прод-бандл без зонда, e2e-бандл с ним', () => {
  const prod = scripts('dist');
  const e2e = scripts('dist-e2e');
  expect(prod.files).toBeGreaterThan(0);
  expect(e2e.files).toBeGreaterThan(0);
  for (const marker of MARKERS) {
    expect(count(e2e.text, marker), `положительный контроль: ${marker} в dist-e2e`).toBeGreaterThan(0);
    expect(count(prod.text, marker), `${marker} в dist`).toBe(0);
  }
});
