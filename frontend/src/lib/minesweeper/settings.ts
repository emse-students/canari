/**
 * Minesweeper player settings (2026-11-04): what the player may tune without touching the rules.
 * Stored per DEVICE in `localStorage` (gestures and vibration are properties of the hardware in the
 * hand, not of the account), read synchronously so the first frame already honours them.
 *
 * Nothing here reaches the engine or the move log: a setting changes how input is READ and how the
 * screen MOVES, never what a move is, so the server replay and the generation fingerprint stay put.
 * The defaults are the behaviour before the settings existed.
 */

/** Speed of the screen's own animations (zoom, overlay, win glow). */
export type AnimationSpeed = 'normal' | 'fast' | 'off';

export interface MinesweeperSettings {
  /** Two quick touch-taps on a cell zoom the board in or out. */
  doubleTapZoom: boolean;
  /** How long a touch is held before it does the secondary action (flag / dig). */
  longPressMs: number;
  /** Vibrate on a long press, a flag, a win and a loss. */
  haptics: boolean;
  animations: AnimationSpeed;
}

export const SETTINGS_STORAGE_KEY = 'canari.minesweeper.settings';

/** The range the long-press slider offers: under 150 ms a tap flags by accident (owner, 2026-11-13: lowered from 200), over 600 it feels broken. */
export const LONG_PRESS_RANGE = { min: 150, max: 600, step: 50 } as const;

export const ANIMATION_SPEEDS: readonly AnimationSpeed[] = ['normal', 'fast', 'off'];

/** Multiplier each speed applies to a base duration. */
const ANIMATION_FACTOR: Record<AnimationSpeed, number> = { normal: 1, fast: 0.5, off: 0 };

export const DEFAULT_SETTINGS: MinesweeperSettings = {
  doubleTapZoom: true,
  longPressMs: 350,
  haptics: true,
  animations: 'normal',
};

/** A base animation duration scaled by the chosen speed; 0 for `off`. */
export function animationMs(baseMs: number, speed: AnimationSpeed): number {
  return Math.round(baseMs * ANIMATION_FACTOR[speed]);
}

/** The multiplier itself, for a CSS custom property. */
export function animationFactor(speed: AnimationSpeed): number {
  return ANIMATION_FACTOR[speed];
}

/** Snaps a long-press delay into the slider's range and step; anything not a number is the default. */
export function clampLongPressMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.longPressMs;
  const { min, max, step } = LONG_PRESS_RANGE;
  const snapped = Math.round(value / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

/** Whether the system asks for less motion - the default of `animations` until the player chooses. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Reads the stored settings. Each field is validated on its own, so one corrupted value falls back
 * to its default without discarding the others; a missing `animations` follows the system's
 * reduced-motion preference.
 */
export function loadMinesweeperSettings(): MinesweeperSettings {
  const defaults: MinesweeperSettings = {
    ...DEFAULT_SETTINGS,
    animations: prefersReducedMotion() ? 'off' : DEFAULT_SETTINGS.animations,
  };
  if (typeof localStorage === 'undefined') return defaults;
  let raw: unknown;
  try {
    const text = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (text === null) return defaults;
    raw = JSON.parse(text);
  } catch (err) {
    console.warn('[minesweeper] stored settings unreadable, using the defaults', err);
    return defaults;
  }
  if (typeof raw !== 'object' || raw === null) return defaults;
  const stored = raw as Record<string, unknown>;
  return {
    doubleTapZoom:
      typeof stored.doubleTapZoom === 'boolean' ? stored.doubleTapZoom : defaults.doubleTapZoom,
    longPressMs:
      'longPressMs' in stored ? clampLongPressMs(stored.longPressMs) : defaults.longPressMs,
    haptics: typeof stored.haptics === 'boolean' ? stored.haptics : defaults.haptics,
    animations: ANIMATION_SPEEDS.includes(stored.animations as AnimationSpeed)
      ? (stored.animations as AnimationSpeed)
      : defaults.animations,
  };
}

/** Persists the settings; a storage that refuses (private mode, quota) is logged, never fatal. */
export function saveMinesweeperSettings(settings: MinesweeperSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('[minesweeper] could not store the settings', err);
  }
}
