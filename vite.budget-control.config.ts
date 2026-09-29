import { defineConfig } from 'vite';
import { cryscadeConfig } from './vite.config.ts';

// Положительный контроль гейта бюджета (§13), только для tests/e2e/bundle.spec.ts, в --mode e2e: там зонд страницы —
// ленивый корень (динамический импорт). CRYSCADE_BUDGET — бюджет, байт gzip: начальный JS обычной e2e-сборки;
// CRYSCADE_STATIC_ROOT — модуль, который вход импортирует статически. Зонд статически — гейт обязан уронить сборку.
const root = process.env['CRYSCADE_STATIC_ROOT'];
export default defineConfig(() => cryscadeConfig({ budget: Number(process.env['CRYSCADE_BUDGET']), ...(root === undefined ? {} : { staticRoot: root }) }));
