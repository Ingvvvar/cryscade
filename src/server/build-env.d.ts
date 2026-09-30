// Режим сборки Vite для корня композиции воркера: воркер собирается той же сборкой, что и страница, и Vite подставляет
// import.meta.env.DEV и MODE литералами — ветка dev и e2e в проде выпадает целиком. Типы vite/client серверу не нужны.

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
