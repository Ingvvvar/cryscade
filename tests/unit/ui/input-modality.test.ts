import { describe, expect, it } from 'vitest';
import { InputModality, type InputEvents, type InputMark } from '../../../src/ui/input-modality.ts';

// Отметка последнего ввода (§11, прогон №6): рамку фокуса видно только после клавиатуры. Окно — подстановка: слушатели
// считаются, события вызываются вручную.

type Listener = (event: KeyboardEvent) => void;

class FakeWindow implements InputEvents {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly captures: boolean[] = [];

  addEventListener(type: 'pointerdown' | 'keydown', listener: Listener, capture: boolean): void {
    this.captures.push(capture);
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: 'pointerdown' | 'keydown', listener: Listener, capture: boolean): void {
    this.captures.push(capture);
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: 'pointerdown' | 'keydown', key = ''): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ key } as KeyboardEvent);
  }

  count(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

function started(): { readonly events: FakeWindow; readonly mark: InputMark; readonly modality: InputModality } {
  const events = new FakeWindow();
  const mark: InputMark = { dataset: {} };
  const modality = new InputModality(events, mark);
  modality.start();
  return { events, mark, modality };
}

describe('отметка последнего ввода', () => {
  it('до первого ввода отметки нет; касание — pointer, клавиша — keyboard; слушатели — на погружении', () => {
    const { events, mark, modality } = started();
    expect([mark.dataset['input'], modality.last]).toStrictEqual([undefined, null]);
    expect(events.count()).toBe(2);
    expect(events.captures).toStrictEqual([true, true]);
    events.fire('pointerdown');
    expect([mark.dataset['input'], modality.last]).toStrictEqual(['pointer', 'pointer']);
    events.fire('keydown', 'Tab');
    expect([mark.dataset['input'], modality.last]).toStrictEqual(['keyboard', 'keyboard']);
    events.fire('pointerdown');
    expect([mark.dataset['input'], modality.last]).toStrictEqual(['pointer', 'pointer']);
  });

  it('модификатор сам по себе ввод с клавиатуры не означает; клавиша с ним — означает', () => {
    const { events, mark, modality } = started();
    events.fire('pointerdown');
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn']) {
      events.fire('keydown', key);
      expect([key, mark.dataset['input'], modality.last]).toStrictEqual([key, 'pointer', 'pointer']);
    }
    events.fire('keydown', ' ');
    expect([mark.dataset['input'], modality.last]).toStrictEqual(['keyboard', 'keyboard']);
  });

  it('dispose снимает оба слушателя: отметка больше не меняется', () => {
    const { events, mark, modality } = started();
    events.fire('keydown', 'Tab');
    modality.dispose();
    expect(events.count()).toBe(0);
    expect(events.captures).toStrictEqual([true, true, true, true]);
    events.fire('pointerdown');
    expect([mark.dataset['input'], modality.last]).toStrictEqual(['keyboard', 'keyboard']);
  });
});
