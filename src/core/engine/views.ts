// Виды только для чтения на буферы движка. Их реализуют сами владельцы буферов, рекордер получает
// владельца под интерфейсом вида: ни одной аллокации на шаг, и изменить ход раунда рекордер не может.
// Вид живёт до следующего шага раунда — хранить нужно копию, а не вид.

export interface GridView {
  symbolAt(cell: number): number;
}

export interface CellsView {
  readonly count: number;
  cellAt(index: number): number;
}

export interface ClusterView {
  readonly count: number;
  symbol(cluster: number): number;
  size(cluster: number): number;
  /** Клетки кластера по возрастанию: index от 0 до size − 1. */
  cellAt(cluster: number, index: number): number;
  /** Сумма множителей клеток по уровням до взрыва; 1 — если их нет. */
  mult(cluster: number): number;
  /** После множителя: таблица × mult. */
  payX100(cluster: number): number;
}

/** Клетки, чей уровень изменился на последнем шаге, по возрастанию, и их новые уровни. */
export interface SpotsView {
  readonly count: number;
  cellAt(index: number): number;
  levelAt(index: number): number;
}

export interface RefillView {
  /** Сдвинувшиеся символы: по колонкам слева направо, в колонке снизу вверх. */
  readonly moveCount: number;
  moveFrom(index: number): number;
  moveTo(index: number): number;
  /** Досыпанные символы по возрастанию клетки. */
  readonly dropCount: number;
  dropCell(index: number): number;
  dropSymbol(index: number): number;
}
