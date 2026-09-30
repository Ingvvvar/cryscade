// Режим сборки Vite для корня композиции воркера: воркер собирается той же сборкой, что и страница, и Vite подставляет
// import.meta.env.DEV и MODE литералами — ветка dev и e2e в проде выпадает целиком. Типы vite/client серверу не нужны.

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly MODE: string;
  readonly BASE_URL: string;
  /** Книга исходов (§5): имя файла в public/books и эталонный SHA-256 несжатых байт — вшиты сборкой (vite.config.ts). */
  readonly CRYSCADE_BOOK_FILE: string;
  readonly CRYSCADE_BOOK_SHA256: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
