/**
 * Shortcuts with the platform's modifier: ⌘ on macOS, Ctrl on Windows and Linux. On macOS Ctrl works as well, as
 * the editors bind it; elsewhere the Windows (Meta) key does not count.
 */

/** What the platform is read from; `navigator` in the webview. */
export interface PlatformInfo {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
}

/** The parts of a keydown a shortcut is matched on. */
export interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * Whether the platform is macOS (or iOS/iPadOS): the User-Agent Client Hints platform when the webview has it, then
 * `navigator.platform`, then the user agent.
 */
export function isMacPlatform(info: PlatformInfo | undefined): boolean {
  if (!info) return false;
  const platform = info.userAgentData?.platform || info.platform || info.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Whether the webview runs on macOS. */
export const IS_MAC = isMacPlatform(globalThis.navigator as PlatformInfo | undefined);

/** A shortcut with the platform's modifier as labels show it: `⌘S` on macOS, `Ctrl+S` elsewhere. */
export function modShortcutLabel(key: string, mac = IS_MAC): string {
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

/** The shortcut that submits a dialog, runs a script or saves an edit, as labels show it: ⌘Enter or Ctrl+Enter. */
export const SUBMIT_KEY = modShortcutLabel('Enter');

/**
 * Whether a keydown is the platform's modifier with `key` (case-insensitive) and no Shift or Alt: ⌘ or Ctrl on macOS,
 * Ctrl without the Windows key elsewhere. A key pressed while an input method composes text never matches.
 */
export function isModShortcut(event: ShortcutEvent, key: string, mac = IS_MAC): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.key.toLowerCase() !== key.toLowerCase() || event.shiftKey || event.altKey) return false;
  return mac ? event.metaKey || event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** ⌘Enter (or Ctrl+Enter) on macOS, Ctrl+Enter on Windows and Linux. */
export function isSubmitShortcut(event: ShortcutEvent, mac = IS_MAC): boolean {
  return isModShortcut(event, 'Enter', mac);
}
