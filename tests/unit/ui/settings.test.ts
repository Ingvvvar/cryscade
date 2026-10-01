import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from '../../../src/client/index.ts';
import { DEFAULT_SETTINGS, SETTINGS_KEY, SettingsStore, jurisdictionParam } from '../../../src/ui/settings.ts';

// Настройки игрока (§11): язык и пресет в localStorage одной записью; хранилище пустое, испорченное и недоступное —
// умолчания, игра идёт; ?jurisdiction= сильнее настройки.

class MemoryStore implements KeyValueStore {
  readonly items = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.items.set(key, value);
  }
}

describe('SettingsStore', () => {
  it('пусто — умолчания: украинский, обычный пресет', () => {
    expect(new SettingsStore(() => new MemoryStore()).getSnapshot()).toStrictEqual({ language: 'uk', preset: 'standard', sound: true });
    expect(DEFAULT_SETTINGS).toStrictEqual({ language: 'uk', preset: 'standard', sound: true });
  });

  it('выбор пишется одной записью и читается новым хранилищем; подписчики слышат только перемену', () => {
    const store = new MemoryStore();
    const settings = new SettingsStore(() => store);
    let heard = 0;
    settings.subscribe(() => {
      heard += 1;
    });
    settings.setLanguage('en');
    settings.setPreset('strict');
    settings.setPreset('strict');
    settings.setSound(false);
    expect(heard).toBe(3);
    expect(store.items.get(SETTINGS_KEY)).toBe('{"v":1,"language":"en","preset":"strict","sound":false}');
    expect(new SettingsStore(() => store).getSnapshot()).toStrictEqual({ language: 'en', preset: 'strict', sound: false });
    // Запись фазы 7 — без звука: он включён.
    store.items.set(SETTINGS_KEY, '{"v":1,"language":"en","preset":"strict"}');
    expect(new SettingsStore(() => store).getSnapshot()).toStrictEqual({ language: 'en', preset: 'strict', sound: true });
  });

  it.each([
    ['не JSON', '{oops'],
    ['не та версия', '{"v":2,"language":"en","preset":"strict"}'],
    ['чужой язык', '{"v":1,"language":"de","preset":"strict"}'],
    ['чужой пресет', '{"v":1,"language":"en","preset":"lax"}'],
    ['не объект', '[1,2]'],
    ['звук не флаг', '{"v":1,"language":"en","preset":"strict","sound":"no"}'],
    ['null', 'null'],
  ])('испорчено (%s) — умолчания', (_, raw) => {
    const store = new MemoryStore();
    store.items.set(SETTINGS_KEY, raw);
    expect(new SettingsStore(() => store).getSnapshot()).toStrictEqual(DEFAULT_SETTINGS);
  });

  it('хранилище недоступно (сам доступ бросает) — умолчания, выбор живёт в памяти', () => {
    const settings = new SettingsStore(() => {
      throw new Error('SecurityError');
    });
    expect(settings.getSnapshot()).toStrictEqual(DEFAULT_SETTINGS);
    settings.setLanguage('en');
    expect(settings.getSnapshot()).toStrictEqual({ language: 'en', preset: 'standard', sound: true });
  });

  it('запись не удалась — выбор живёт в памяти, подписчики слышат', () => {
    const store = new MemoryStore();
    store.failWrites = true;
    const settings = new SettingsStore(() => store);
    let heard = 0;
    settings.subscribe(() => {
      heard += 1;
    });
    settings.setPreset('strict');
    expect([settings.getSnapshot().preset, heard, store.items.size]).toStrictEqual(['strict', 1, 0]);
  });
});

describe('jurisdictionParam', () => {
  it.each([
    ['?jurisdiction=strict', 'strict'],
    ['?renderer=webgl&jurisdiction=strict', 'strict'],
    ['?jurisdiction=standard', 'standard'],
    ['', null],
    ['?jurisdiction=STRICT', null],
    ['?jurisdiction=', null],
  ])('%s → %s', (search, preset) => {
    expect(jurisdictionParam(search)).toBe(preset);
  });
});
