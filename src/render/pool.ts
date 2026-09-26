// Object Pool (§3): все объекты созданы в конструкторе, в кадре пул не растёт и не аллоцирует.
// Инвариант: выданный объект возвращается ровно один раз и только в свой пул; пустой пул — ошибка, а не рост.

export class Pool<T extends object> {
  readonly #free: T[];
  readonly #issued = new Set<T>();
  readonly #reset: (item: T) => void;
  readonly capacity: number;

  constructor(capacity: number, create: () => T, reset: (item: T) => void) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError(`ёмкость пула — целое больше нуля: ${String(capacity)}`);
    this.capacity = capacity;
    this.#reset = reset;
    this.#free = [];
    for (let i = 0; i < capacity; i++) this.#free.push(create());
  }

  get available(): number {
    return this.#free.length;
  }

  acquire(): T {
    const item = this.#free.pop();
    if (item === undefined) throw new Error(`пул исчерпан: ёмкость ${String(this.capacity)}`);
    this.#issued.add(item);
    return item;
  }

  release(item: T): void {
    if (!this.#issued.delete(item)) throw new Error('объект не выдан этим пулом или уже возвращён');
    this.#reset(item);
    this.#free.push(item);
  }
}
