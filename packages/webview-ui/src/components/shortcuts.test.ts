import { describe, expect, it } from 'vitest';
import { isMacPlatform, isModShortcut, isSubmitShortcut, modShortcutLabel, type ShortcutEvent } from './shortcuts';

const key = (k: string, mods: Partial<ShortcutEvent> = {}): ShortcutEvent => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('isMacPlatform', () => {
  it('reads the client hints platform first', () => {
    expect(isMacPlatform({ userAgentData: { platform: 'macOS' }, platform: 'Win32' })).toBe(true);
    expect(isMacPlatform({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe(false);
    expect(isMacPlatform({ userAgentData: { platform: 'Linux' } })).toBe(false);
  });

  it('falls back to navigator.platform, then the user agent', () => {
    expect(isMacPlatform({ userAgentData: { platform: '' }, platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ platform: 'Win32', userAgent: 'Macintosh' })).toBe(false);
    expect(isMacPlatform({ platform: 'Linux x86_64' })).toBe(false);
    expect(isMacPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Code/1.105.0 Electron/37.6.0' })).toBe(true);
    expect(isMacPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Code/1.105.0 Electron/37.6.0' })).toBe(false);
    expect(isMacPlatform({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' })).toBe(true);
  });

  it('is not macOS without anything to read', () => {
    expect(isMacPlatform({})).toBe(false);
    expect(isMacPlatform(undefined)).toBe(false);
  });
});

describe('modShortcutLabel', () => {
  it('names the platform modifier', () => {
    expect(modShortcutLabel('Enter', true)).toBe('⌘Enter');
    expect(modShortcutLabel('Enter', false)).toBe('Ctrl+Enter');
    expect(modShortcutLabel('S', true)).toBe('⌘S');
    expect(modShortcutLabel('S', false)).toBe('Ctrl+S');
  });
});

describe('isSubmitShortcut', () => {
  it('takes ⌘Enter and Ctrl+Enter on macOS', () => {
    expect(isSubmitShortcut(key('Enter', { metaKey: true }), true)).toBe(true);
    expect(isSubmitShortcut(key('Enter', { ctrlKey: true }), true)).toBe(true);
    expect(isSubmitShortcut(key('Enter', { ctrlKey: true, metaKey: true }), true)).toBe(true);
  });

  it('takes only Ctrl+Enter on Windows and Linux, not the Windows key', () => {
    expect(isSubmitShortcut(key('Enter', { ctrlKey: true }), false)).toBe(true);
    expect(isSubmitShortcut(key('Enter', { metaKey: true }), false)).toBe(false);
    expect(isSubmitShortcut(key('Enter', { ctrlKey: true, metaKey: true }), false)).toBe(false);
  });

  it('needs the modifier', () => {
    expect(isSubmitShortcut(key('Enter'), true)).toBe(false);
    expect(isSubmitShortcut(key('Enter'), false)).toBe(false);
  });

  it('leaves out Shift and Alt combinations', () => {
    for (const mac of [true, false]) {
      expect(isSubmitShortcut(key('Enter', { ctrlKey: true, metaKey: mac, shiftKey: true }), mac)).toBe(false);
      expect(isSubmitShortcut(key('Enter', { ctrlKey: true, metaKey: mac, altKey: true }), mac)).toBe(false);
    }
  });

  it('ignores keys while an input method composes text', () => {
    for (const mac of [true, false]) {
      expect(isSubmitShortcut(key('Enter', { ctrlKey: true, isComposing: true }), mac)).toBe(false);
      expect(isSubmitShortcut(key('Enter', { ctrlKey: true, keyCode: 229 }), mac)).toBe(false);
    }
  });

  it('is only Enter', () => {
    expect(isSubmitShortcut(key('a', { metaKey: true }), true)).toBe(false);
    expect(isSubmitShortcut(key('a', { ctrlKey: true }), false)).toBe(false);
  });
});

describe('isModShortcut', () => {
  it('matches the letter in either case', () => {
    expect(isModShortcut(key('s', { metaKey: true }), 's', true)).toBe(true);
    expect(isModShortcut(key('S', { ctrlKey: true }), 's', false)).toBe(true);
    expect(isModShortcut(key('s', { metaKey: true }), 's', false)).toBe(false);
    expect(isModShortcut(key('d', { ctrlKey: true }), 's', false)).toBe(false);
  });
});
