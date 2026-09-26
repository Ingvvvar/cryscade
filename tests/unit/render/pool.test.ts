import { describe, expect, it } from 'vitest';
import { Pool } from '../../../src/render/pool.ts';

interface Item {
  id: number;
  dirty: boolean;
}

function makePool(capacity: number): { pool: Pool<Item>; created: Item[] } {
  const created: Item[] = [];
  const pool = new Pool<Item>(
    capacity,
    () => {
      const item = { id: created.length, dirty: false };
      created.push(item);
      return item;
    },
    (item) => {
      item.dirty = false;
    },
  );
  return { pool, created };
}

describe('Pool', () => {
  it('всё создаётся в конструкторе, выдача ничего не создаёт', () => {
    const { pool, created } = makePool(3);
    expect(created).toHaveLength(3);
    const a = pool.acquire();
    pool.acquire();
    expect(created).toHaveLength(3);
    expect(created).toContain(a);
    expect(pool.available).toBe(1);
  });

  it('исчерпанный пул — ошибка, а не рост', () => {
    const { pool, created } = makePool(2);
    pool.acquire();
    pool.acquire();
    expect(() => pool.acquire()).toThrow(/исчерпан/);
    expect(created).toHaveLength(2);
  });

  it('возврат сбрасывает объект и снова делает его доступным', () => {
    const { pool } = makePool(1);
    const item = pool.acquire();
    item.dirty = true;
    pool.release(item);
    expect(item.dirty).toBe(false);
    expect(pool.available).toBe(1);
    expect(pool.acquire()).toBe(item);
  });

  it('двойной возврат и чужой объект — ошибка', () => {
    const { pool } = makePool(2);
    const item = pool.acquire();
    pool.release(item);
    expect(() => {
      pool.release(item);
    }).toThrow(/не выдан/);
    expect(() => {
      pool.release({ id: 99, dirty: false });
    }).toThrow(/не выдан/);
    expect(pool.available).toBe(2);
  });

  it('ёмкость — целое больше нуля', () => {
    expect(() => makePool(0)).toThrow(RangeError);
    expect(() => makePool(1.5)).toThrow(RangeError);
  });
});
