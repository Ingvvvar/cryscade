import { defineConfig } from 'vite';
import { cryscadeConfig } from './vite.config.ts';

// Положительные контроли гейта бюджета (§13), только для tests/e2e/bundle.spec.ts, в --mode e2e: там зонд страницы —
// ленивый корень (динамический импорт). CRYSCADE_BUDGET — бюджет, байт gzip, обязателен: без него порог — NaN, и гейт
// роняет сборку понятной ошибкой. CRYSCADE_STATIC_ROOT — модули через запятую, которые вход импортирует статически:
// ленивый модуль статически — гейт обязан уронить сборку при любом пороге.
// Режим — как у настоящей сборки: в e2e — профилирующий react-dom, иначе контроль мерил бы другой начальный JS.
const roots = process.env['CRYSCADE_STATIC_ROOT']?.split(',');
export default defineConfig(({ mode }) =>
  cryscadeConfig({ budget: Number(process.env['CRYSCADE_BUDGET']), profiling: mode === 'e2e', ...(roots === undefined ? {} : { staticRoots: roots }) }),
);
