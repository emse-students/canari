import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The iOS keyboard is handed to the page on both edges (`canari_ios.mm`;
 * docs/wiki/frontend/keyboard-and-send-motion.md, section 5). iPhone 12, 2026-11-13: animating the
 * frame on a rise slid the page up BEHIND the keyboard, the composer hidden for ~150 ms; on a fall the
 * page jumped full height while Messenger's composer rides down on the keys. Nothing compiles the
 * Objective-C against the page, so this reads both as text: the native side calls the hooks the page
 * defines, proves the rise's layout is on screen before the frame changes, sets the frame without
 * animation, and announces a ridable fall with the keyboard's own timing before resizing.
 */
describe('the iOS keyboard hand-off (canari_ios.mm)', () => {
  const native = readFileSync('src-tauri/gen/apple/Sources/canari/canari_ios.mm', 'utf8');
  const viewport = readFileSync('src/lib/stores/keyboardViewport.svelte.ts', 'utf8');
  const chatArea = readFileSync('src/lib/components/chat/ChatArea.svelte', 'utf8');
  const body = (signature: string) => {
    const from = native.slice(native.indexOf(signature));
    return from.slice(0, from.indexOf('\n}\n'));
  };
  const proof = body('static void CanariAfterScreenUpdates(');
  const rise = body('static void CanariHandKeyboardRiseToPage(');
  const fall = body('static void CanariHandKeyboardFallToPage(');
  const snap = body('static void CanariSnapKeyboardFrame(');
  const apply = body('static void CanariApplyKeyboardLayout(');

  it('the proof is the public screen-update snapshot, never the private presentation hook', () => {
    expect(proof).toContain('proof.afterScreenUpdates = YES;');
    expect(proof).toContain('[webView takeSnapshotWithConfiguration:proof');
    expect(native).not.toMatch(/\[\w+ _doAfterNextPresentationUpdate/);
  });

  it('a rise calls the hook the page defines, then sets the frame only after the proof', () => {
    expect(viewport).toContain('.canariImeTarget =');
    expect(rise).toContain('window.canariImeTarget?.(%.2f) === true');
    const afterScript = rise.slice(rise.indexOf('completionHandler:'));
    const proved = afterScript.indexOf('CanariAfterScreenUpdates(webView, ^');
    const superseded = afterScript.indexOf('seq != g_keyboardChangeSeq', proved);
    const set = afterScript.lastIndexOf('CanariSnapKeyboardFrame(webView, target)');
    expect(proved).toBeGreaterThan(-1);
    expect(superseded).toBeGreaterThan(proved);
    expect(set).toBeGreaterThan(superseded);
  });

  it('a rise logs the script and the proof apart, and a rise ended without proof distinctly', () => {
    expect(rise).toContain('(script %.0f ms, proof %.0f ms)');
    expect(body('static void CanariEndPendingRise(')).toContain('ended WITHOUT its proof after');
  });

  it('the frame is set without animation, any running frame animation removed first', () => {
    const removed = snap.indexOf('[webView.layer removeAllAnimations];');
    const set = snap.indexOf('performWithoutAnimation');
    expect(removed).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(removed);
  });

  it("a fall is announced with the keyboard's own duration and curve BEFORE the resize", () => {
    expect(viewport).toContain('.canariKeyboardFall =');
    expect(fall).toContain('UIKeyboardAnimationDurationUserInfoKey');
    expect(fall).toContain('UIKeyboardAnimationCurveUserInfoKey');
    const announce = fall.indexOf('window.canariKeyboardFall?.(');
    const resize = fall.indexOf('CanariSnapKeyboardFrame(webView, target)');
    expect(announce).toBeGreaterThan(-1);
    expect(resize).toBeGreaterThan(announce);
    expect(apply).toContain('CanariHandKeyboardFallToPage(webView, target, note, fromOverlap)');
  });

  it('a fall with nothing to ride is not announced: instant, too short to have opened, not local', () => {
    expect(fall).toContain('durationMs > 0');
    expect(fall).toContain('fromOverlap >= kCanariKeyboardOpenThresholdPt');
    expect(fall).toContain('UIKeyboardIsLocalUserInfoKey');
    expect(fall.indexOf('if (ridable)')).toBeLessThan(fall.indexOf('window.canariKeyboardFall?.('));
  });

  it("native's open threshold is the page's iOS one", () => {
    const nativePt = /kCanariKeyboardOpenThresholdPt = (\d+(?:\.\d+)?);/.exec(native)?.[1];
    const pagePx = /=== 'ios' \? (\d+) :/.exec(viewport)?.[1];
    expect(nativePt).toBeDefined();
    expect(Number(nativePt)).toBe(Number(pagePx));
  });

  it('withdraws the target only when a rise is pending, before the no-change test', () => {
    expect(apply).toContain('BOOL rise = overlap > 0 && fromOverlap == 0;');
    expect(apply).toContain('if (overlap == 0 && riseWasPending) {');
    const withdraw = apply.indexOf('window.canariImeTarget?.(0)');
    const noChange = apply.indexOf('if (CGRectEqualToRect(webView.frame, target))');
    expect(withdraw).toBeGreaterThan(-1);
    expect(noChange).toBeGreaterThan(withdraw);
    expect(apply.indexOf('g_keyboardChangeSeq++')).toBeLessThan(noChange);
  });

  it('a navigation ends a rise in flight', () => {
    expect(native).toContain('forKeyPath:@"URL"');
    const observer = native.slice(
      native.indexOf('@implementation CanariKeyboardNavigationObserver')
    );
    expect(observer.slice(0, observer.indexOf('@end'))).toContain('CanariEndPendingRise(');
    expect(apply).toContain('CanariObserveKeyboardNavigation(webView);');
  });

  it('the conversation marks its riding pieces: the composer band by its box, the thread by its last row', () => {
    expect(chatArea).toContain('data-keyboard-ride="box"');
    expect(chatArea).toContain('data-keyboard-ride="last-row"');
  });
});
