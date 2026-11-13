import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The iOS keyboard is handed to the page on both edges (`canari_ios.mm`;
 * docs/wiki/frontend/keyboard-and-send-motion.md, section 5). iPhone 12, 2026-11-13: animating the
 * frame on a rise slid the page up BEHIND the keyboard, the composer hidden for ~150 ms; on a fall the
 * page jumped full height while Messenger's composer rides down on the keys. Nothing compiles the
 * Objective-C against the page, so this reads both as text: the native side calls the hooks the page
 * defines, proves the rise's layout is on screen before the frame changes, sets the frame without
 * animation, and announces a fall with the keyboard's own timing before resizing.
 */
describe('the iOS keyboard hand-off (canari_ios.mm)', () => {
  const native = readFileSync('src-tauri/gen/apple/Sources/canari/canari_ios.mm', 'utf8');
  const viewport = readFileSync('src/lib/stores/keyboardViewport.svelte.ts', 'utf8');
  const chatArea = readFileSync('src/lib/components/chat/ChatArea.svelte', 'utf8');
  const body = (signature: string) => {
    const from = native.slice(native.indexOf(signature));
    return from.slice(0, from.indexOf('\n}\n'));
  };
  const rise = body('static void CanariHandKeyboardRiseToPage(');
  const fall = body('static void CanariHandKeyboardFallToPage(');
  const snap = body('static void CanariSnapKeyboardFrame(');
  const apply = body('static void CanariApplyKeyboardLayout(');

  it('a rise calls the hook the page defines, then waits for a screen-update proof, not frames', () => {
    expect(viewport).toContain('.canariImeTarget =');
    expect(rise).toContain('window.canariImeTarget?.(%.2f) === true');
    expect(rise).toContain('afterScreenUpdates = YES');
    expect(rise).toContain('takeSnapshotWithConfiguration:proof');
    expect(rise).not.toContain('requestAnimationFrame');
    expect(native).not.toContain('_doAfterNextPresentationUpdate:');
  });

  it('a rise sets the frame only after the proof, drops a superseded answer, and logs its cost', () => {
    const proof = rise.slice(rise.indexOf('takeSnapshotWithConfiguration:proof'));
    const superseded = proof.indexOf('seq != g_keyboardChangeSeq');
    const set = proof.indexOf('CanariSnapKeyboardFrame(webView, target)');
    expect(superseded).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(superseded);
    expect(proof).toContain('is on screen after %.0f ms');
  });

  it('the frame is set without animation and settled once in place', () => {
    expect(snap).toContain('performWithoutAnimation');
    expect(snap).toContain('CanariKeyboardLayoutSettled(webView)');
  });

  it("a fall is announced with the keyboard's own duration and curve BEFORE the resize", () => {
    expect(viewport).toContain('.canariKeyboardFall =');
    expect(fall).toContain('UIKeyboardAnimationDurationUserInfoKey');
    expect(fall).toContain('UIKeyboardAnimationCurveUserInfoKey');
    const announce = fall.indexOf('window.canariKeyboardFall?.(');
    const resize = fall.indexOf('CanariSnapKeyboardFrame(webView, target)');
    expect(announce).toBeGreaterThan(-1);
    expect(resize).toBeGreaterThan(announce);
    expect(apply).toContain('CanariHandKeyboardFallToPage(webView, target, note)');
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

  it('the conversation marks its riding pieces: the composer band anchors, the thread rides at its bottom', () => {
    expect(chatArea).toContain('data-keyboard-ride="anchor"');
    expect(chatArea).toContain('data-keyboard-ride="when-at-bottom"');
  });
});
