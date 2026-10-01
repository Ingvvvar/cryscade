// Форматы диалогов (§11): множитель выплаты и время раунда — по локали словаря. Выплата хранится целыми сотыми ставки
// (payX100); здесь она только показывается: ниже 10× — две цифры после запятой, выше — целое (§4.4).

export function multiplier(payX100: number, locale: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: payX100 < 1000 ? 2 : 0, maximumFractionDigits: 2 }).format(payX100 / 100);
}

export function roundTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }).format(at);
}
