import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../../src/client/index.ts';
import { PresentationPreferences } from '../../../src/ui/presentation-preferences.ts';
import type { MediaQueryListLike } from '../../../src/ui/viewport-watcher.ts';

// Параметры показа (§8.2, §11): турбо — кнопкой, пресет — адресом или настройкой, reduced motion — медиа-запросом. Показ
// читает их на старте раунда; турбо и пропуск — только если пресет их разрешает; выбранный посреди раунда пресет — со
// следующего.

class Motion implements MediaQueryListLike {
  matches = false;

  addEventListener(): void {
    // Параметры читаются на старте раунда: слушать изменения не нужно.
  }

  removeEventListener(): void {
    // То же.
  }
}

describe('PresentationPreferences', () => {
  it('обычный пресет: турбо переключается кнопкой, подписчики слышат; пропуск разрешён', () => {
    const motion = new Motion();
    const preferences = new PresentationPreferences(PRESETS.standard, motion);
    let heard = 0;
    preferences.subscribe(() => {
      heard += 1;
    });
    expect(preferences.getSnapshot()).toStrictEqual({ turbo: false, preset: PRESETS.standard });
    expect(preferences.options()).toStrictEqual({ speed: 'normal', preset: PRESETS.standard, reducedMotion: false });
    preferences.toggleTurbo();
    motion.matches = true;
    expect(preferences.getSnapshot()).toStrictEqual({ turbo: true, preset: PRESETS.standard });
    expect(preferences.options()).toStrictEqual({ speed: 'turbo', preset: PRESETS.standard, reducedMotion: true });
    expect(preferences.skip).toBe(true);
    expect(heard).toBe(1);
  });

  it('строгий пресет: турбо не включается, пропуска нет, минимальный цикл — в параметрах расписания', () => {
    const preferences = new PresentationPreferences(PRESETS.strict, new Motion());
    let heard = 0;
    preferences.subscribe(() => {
      heard += 1;
    });
    preferences.toggleTurbo();
    expect(preferences.getSnapshot()).toStrictEqual({ turbo: false, preset: PRESETS.strict });
    expect(preferences.options().speed).toBe('normal');
    expect(preferences.options().preset.minSpinCycleMs).toBe(2500);
    expect(preferences.skip).toBe(false);
    expect(heard).toBe(0);
  });

  it('пресет посреди раунда — со следующего: панель видит выбор сразу, раунд на сцене доигрывает со своим', () => {
    const preferences = new PresentationPreferences(PRESETS.standard, new Motion());
    let heard = 0;
    preferences.subscribe(() => {
      heard += 1;
    });
    preferences.toggleTurbo();
    expect(preferences.options()).toStrictEqual({ speed: 'turbo', preset: PRESETS.standard, reducedMotion: false });
    preferences.setPreset(PRESETS.strict);
    expect([preferences.getSnapshot().preset, preferences.skip]).toStrictEqual([PRESETS.strict, true]);
    expect(preferences.options()).toStrictEqual({ speed: 'normal', preset: PRESETS.strict, reducedMotion: false });
    expect(preferences.skip).toBe(false);
    preferences.setPreset(PRESETS.strict);
    expect(heard).toBe(2);
    preferences.setPreset(PRESETS.standard);
    expect(preferences.options()).toStrictEqual({ speed: 'turbo', preset: PRESETS.standard, reducedMotion: false });
    expect([preferences.skip, heard]).toStrictEqual([true, 3]);
  });

  it('отписка работает', () => {
    const preferences = new PresentationPreferences(PRESETS.standard, new Motion());
    let heard = 0;
    const unsubscribe = preferences.subscribe(() => {
      heard += 1;
    });
    unsubscribe();
    preferences.toggleTurbo();
    expect(heard).toBe(0);
  });
});
