import { defineConfig } from 'vite';
import { cryscadeConfig } from './vite.config.ts';

// Положительные контроли гейта бюджета (§13), только для tests/e2e/bundle.spec.ts, в --mode e2e: там зонд страницы —
// ленивый корень (динамический импорт). CRYSCADE_BUDGET — бюджет, байт gzip, обязателен: без него порог — NaN, и гейт
// роняет сборку понятной ошибкой. CRYSCADE_STATIC_ROOT — модуль, который вход импортирует статически: зонд статически —
// гейт обязан уронить сборку при любом пороге.
const root = process.env['CRYSCADE_STATIC_ROOT'];
export default defineConfig(() => cryscadeConfig({ budget: Number(process.env['CRYSCADE_BUDGET']), ...(root === undefined ? {} : { staticRoot: root }) }));
