// Язык игрока для компонентов (§11): словарь, формат сумм и надписи сцены — одним значением контекста. Корень (App)
// кладёт в него снимок LanguageStore; без провайдера — украинский.

import { createContext, useContext } from 'react';
import { UK } from './i18n/uk.ts';
import { languageView, type LanguageView } from './language.ts';

export const LanguageContext = createContext<LanguageView>(languageView(UK));

export function useLanguage(): LanguageView {
  return useContext(LanguageContext);
}
