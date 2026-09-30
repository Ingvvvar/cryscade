import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../../src/client/index.ts';
import { PresentationPreferences, presetChoice } from '../../../src/ui/presentation-preferences.ts';
import type { MediaQueryListLike } from '../../../src/ui/viewport-watcher.ts';

// Параметры показа (§8.2, §11): турбо — кнопкой, пресет — адресом, reduced motion — медиа-запросом. Показ читает их на
// старте раунда; турбо и пропуск — только если пресет их разрешает.

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
    expect(preferences.getSnapshot()).toStrictEqual({ turbo: false, turboAllowed: true });
    expect(preferences.options()).toStrictEqual({ speed: 'normal', preset: PRESETS.standard, reducedMotion: false });
    preferences.toggleTurbo();
    motion.matches = true;
    expect(preferences.getSnapshot()).toStrictEqual({ turbo: true, turboAllowed: true });
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
    expect(preferences.getSnapshot()).toStrictEqual({ turbo: false, turboAllowed: false });
    expect(preferences.options().speed).toBe('normal');
    expect(preferences.options().preset.minSpinCycleMs).toBe(2500);
    expect(preferences.skip).toBe(false);
    expect(heard).toBe(0);
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

describe('presetChoice', () => {
  it.each([
    ['?jurisdiction=strict', PRESETS.strict],
    ['?renderer=webgl&jurisdiction=strict', PRESETS.strict],
    ['', PRESETS.standard],
    ['?jurisdiction=standard', PRESETS.standard],
    ['?jurisdiction=STRICT', PRESETS.standard],
  ])('%s', (search, preset) => {
    expect(presetChoice(search)).toBe(preset);
  });
});
