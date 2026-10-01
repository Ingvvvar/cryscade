// Иконки символов для правил (§11): корень композиции отдаёт сюда каждый созданный рендерер — живых не больше одного
// (SceneMount), последний созданный и есть живой или будущий. Диалог правил спрашивает иконки через фасад рендера;
// рендерера нет или его сцена не готова — null, и правила пишут имена символов текстом.

import type { SymbolIcons } from '../render/renderer.ts';

export class RendererIcons implements SymbolIcons {
  #current: SymbolIcons | null = null;

  /** Рендерер из фабрики — тот же, дальше. */
  track<R extends SymbolIcons>(renderer: R): R {
    this.#current = renderer;
    return renderer;
  }

  symbolIcons(): Promise<readonly string[] | null> {
    return this.#current?.symbolIcons() ?? Promise.resolve(null);
  }
}
