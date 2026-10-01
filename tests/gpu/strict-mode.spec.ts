import { test } from '@playwright/test';
import { mountsOnce, remountsLive } from '../support/strict-mode.ts';

// StrictMode на WebGPU (§10, фаза 9): WebGPU есть только на настоящем GPU — поэтому здесь, в GPU-проекте, на dev-сервере
// (двойной монтаж — только в dev-сборке React). Вариант WebGL — в e2e (tests/e2e/strict-mode.spec.ts), он идёт и в CI.

test('webgpu: монтирований 2, рендерер один, канвас один, консоль без предупреждений', async ({ page }) => {
  await mountsOnce(page, 'webgpu');
});

test('webgpu: перемонтирование живой сцены — новый канвас, новый init проходит, консоль чистая', async ({ page }) => {
  await remountsLive(page, 'webgpu');
});
