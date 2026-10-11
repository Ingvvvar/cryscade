// Последний ввод игрока — указатель или клавиатура (§11): рамку фокуса видно только после клавиатуры. Одного
// :focus-visible мало: фокус, который ставит скрипт после касания (диалог — на свой первый элемент), WebKit считает
// видимым — проба прогона №6: на iPhone вокруг «×» в «Історії» и «Чесності» проступала рамка. Отметка — data-input у
// <html>: pointer после pointerdown (касание, мышь, перо), keyboard после клавиши; правило рамки — в styles.css.

/** Окно в той мере, в какой оно нужно отметке: в тестах — подстановка. Слушаем на погружении — раньше игры. */
export interface InputEvents {
  addEventListener(type: 'pointerdown', listener: () => void, capture: boolean): void;
  addEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void, capture: boolean): void;
  removeEventListener(type: 'pointerdown', listener: () => void, capture: boolean): void;
  removeEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void, capture: boolean): void;
}

/** Куда ставится отметка: корень документа. */
export interface InputMark {
  readonly dataset: DOMStringMap;
}

type InputKind = 'pointer' | 'keyboard';

/** Модификатор сам по себе — не ввод с клавиатуры: Cmd или Ctrl перед кликом рамку не включают. */
const MODIFIERS: readonly string[] = ['Alt', 'AltGraph', 'CapsLock', 'Control', 'Fn', 'Meta', 'Shift'];

export class InputModality {
  readonly #events: InputEvents;
  readonly #mark: InputMark;
  readonly #onPointer = (): void => {
    this.#set('pointer');
  };
  readonly #onKey = (event: KeyboardEvent): void => {
    if (!MODIFIERS.includes(event.key)) this.#set('keyboard');
  };

  constructor(events: InputEvents, mark: InputMark) {
    this.#events = events;
    this.#mark = mark;
  }

  start(): void {
    this.#events.addEventListener('pointerdown', this.#onPointer, true);
    this.#events.addEventListener('keydown', this.#onKey, true);
  }

  dispose(): void {
    this.#events.removeEventListener('pointerdown', this.#onPointer, true);
    this.#events.removeEventListener('keydown', this.#onKey, true);
  }

  #set(kind: InputKind): void {
    this.#mark.dataset.input = kind;
  }
}
