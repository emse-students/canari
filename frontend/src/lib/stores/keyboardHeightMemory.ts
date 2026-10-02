import { Log } from '$lib/utils/Log';

/**
 * THE LAST KEYBOARD HEIGHT THIS DEVICE SHOWED, PER ORIENTATION - the height the composer's GIF panel
 * takes, so switching keyboard <-> panel moves nothing (user, 2026-10-02: *"un panneau de la taille
 * du clavier"*).
 *
 * Written by `keyboardViewport` every time it measures an open keyboard, so the LATEST keyboard wins
 * (a suggestion bar shown or hidden, another keyboard app). Kept in `localStorage` so the first panel
 * after a restart is already the right height; with nothing stored the panel uses the documented
 * first guess (`gifPanelHeight`). It is a per-device convenience, never shared state: a value lost
 * to a private window only costs that first guess.
 */

const STORAGE_KEY = 'canari.keyboardHeight.v1';

export type Orientation = 'portrait' | 'landscape';

/** The orientation of the current window, from its shape. */
export function currentOrientation(): Orientation {
  if (typeof window === 'undefined') return 'portrait';
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
}

let memory: Partial<Record<Orientation, number>> | null = null;

function load(): Partial<Record<Orientation, number>> {
  if (memory) return memory;
  memory = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<Orientation, unknown>>;
      for (const o of ['portrait', 'landscape'] as const) {
        const v = parsed[o];
        if (typeof v === 'number' && v > 0) memory[o] = v;
      }
    }
  } catch (error) {
    console.warn(
      `[KeyboardHeightMemory] stored height unreadable, starting empty: ${String(error)}`
    );
  }
  return memory;
}

/** Records an open keyboard's height for the current orientation. */
export function rememberKeyboardHeight(height: number, orientation = currentOrientation()): void {
  const store = load();
  const rounded = Math.round(height);
  if (store[orientation] === rounded) return;
  store[orientation] = rounded;
  Log.d('KeyboardHeightMemory', `${orientation}: ${rounded}px`);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    console.warn(`[KeyboardHeightMemory] height not persisted: ${String(error)}`);
  }
}

/** The last keyboard height measured in this orientation, or null if none was ever seen. */
export function rememberedKeyboardHeight(orientation = currentOrientation()): number | null {
  return load()[orientation] ?? null;
}

/** Forgets everything - tests only. */
export function resetKeyboardHeightMemoryForTests(): void {
  memory = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A test environment without storage has nothing to clear.
  }
}
