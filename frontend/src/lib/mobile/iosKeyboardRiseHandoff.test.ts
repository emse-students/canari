import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The iOS keyboard rise is handed to the page before the WebView is resized (`canari_ios.mm`,
 * `CanariHandKeyboardRiseToPage`; docs/wiki/frontend/keyboard-and-send-motion.md). iPhone 12,
 * 2026-11-13: animating the frame on a rise slid the page up BEHIND the keyboard, the composer hidden
 * for ~150 ms. Nothing compiles the Objective-C against the page, so this reads both as text: the
 * native side must call the hook the page defines, set the frame only once the page answered, without
 * animation, and withdraw the target when the keyboard falls first.
 */
describe('the iOS keyboard rise hand-off (canari_ios.mm)', () => {
  const native = readFileSync('src-tauri/gen/apple/Sources/canari/canari_ios.mm', 'utf8');
  const viewport = readFileSync('src/lib/stores/keyboardViewport.svelte.ts', 'utf8');
  const handOff = (() => {
    const from = native.slice(native.indexOf('static void CanariHandKeyboardRiseToPage('));
    return from.slice(0, from.indexOf('\n}\n'));
  })();
  const apply = (() => {
    const from = native.slice(native.indexOf('static void CanariApplyKeyboardLayout('));
    return from.slice(0, from.indexOf('\n}\n'));
  })();

  it('calls the hook the page defines, and waits two frames for the layout to be committed', () => {
    expect(viewport).toContain('.canariImeTarget =');
    expect(handOff).toContain('window.canariImeTarget?.(px) !== true');
    expect(handOff).toContain('requestAnimationFrame(() => requestAnimationFrame(r))');
  });

  it('sets the frame in the answer, without animation, and drops a superseded answer', () => {
    const answer = handOff.slice(handOff.indexOf('completionHandler:'));
    const superseded = answer.indexOf('seq != g_keyboardChangeSeq');
    const snap = answer.indexOf('performWithoutAnimation');
    expect(superseded).toBeGreaterThan(-1);
    expect(snap).toBeGreaterThan(superseded);
    expect(answer).not.toContain('animateWithDuration');
  });

  it('hands only a rise from full height; a fall withdraws the target before the no-change test', () => {
    expect(apply).toContain(
      'BOOL rise = overlap > 0 && CGRectGetHeight(webView.frame) >= CGRectGetHeight(parent.bounds);'
    );
    const withdraw = apply.indexOf('window.canariImeTarget?.(0)');
    const noChange = apply.indexOf('if (!frameChanges)');
    expect(withdraw).toBeGreaterThan(-1);
    expect(noChange).toBeGreaterThan(withdraw);
    expect(apply.indexOf('g_keyboardChangeSeq++')).toBeLessThan(noChange);
  });
});
