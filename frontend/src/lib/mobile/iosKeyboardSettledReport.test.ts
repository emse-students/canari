import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The settled-keyboard report of `canari_ios.mm` (iPhone 12, v1.2.9-alpha.7: in a DM the native glass
 * pieces stood one keyboard overlap above their web twins). The store build cannot be inspected, so
 * this one syslog line is the only place the next reading can tell the three candidate causes apart.
 * It must keep running after every keyboard change, and the composer it reads must be the one the
 * page renders - a renamed class would report `composerTop=none` and lose the third cause silently.
 */
describe('the settled-keyboard geometry report (canari_ios.mm)', () => {
  const native = readFileSync('src-tauri/gen/apple/Sources/canari/canari_ios.mm', 'utf8');
  const composer = readFileSync('src/lib/components/chat/ChatComposer.svelte', 'utf8');

  it('runs once every keyboard layout is in place, after the clamp', () => {
    const settled = native.slice(native.indexOf('static void CanariKeyboardLayoutSettled('));
    const body = settled.slice(0, settled.indexOf('\n}\n'));
    const clamp = body.indexOf('CanariClampDocumentScroll(webView.scrollView)');
    const report = body.indexOf('CanariReportSettledKeyboardGeometry(webView)');
    expect(clamp).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(clamp);
    // The report reads the PAGE, so it runs once the page's reaction to the resize is on screen -
    // after a screen-update proof - and only for the keyboard change still current: every call to the
    // settle sits inside a proof's callback, behind a sequence check.
    const calls = native.split('CanariKeyboardLayoutSettled(webView);').length - 1;
    expect(calls).toBe(2);
    for (const signature of [
      'static void CanariSnapKeyboardFrame(',
      'completion:^(__unused BOOL finished)',
    ]) {
      const from = native.slice(native.indexOf(signature));
      const until = from.indexOf('CanariKeyboardLayoutSettled(webView);');
      const before = from.slice(0, until);
      expect(until).toBeGreaterThan(-1);
      expect(before).toContain('CanariAfterScreenUpdates(webView,');
      expect(before.lastIndexOf('g_keyboardChangeSeq')).toBeGreaterThan(
        before.indexOf('CanariAfterScreenUpdates(webView,')
      );
    }
  });

  it('reads both halves: UIKit offset and range, and the page scroll, viewport and composer', () => {
    for (const field of ['native offset=', 'content=', 'bounds=']) expect(native).toContain(field);
    for (const field of [
      'scrollY=',
      'scrollHeight=',
      'innerHeight=',
      'vvHeight=',
      'vvOffsetTop=',
      'vvPageTop=',
      'composerTop=',
    ])
      expect(native).toContain(field);
  });

  it('reads the composer footer the chat actually renders', () => {
    expect(native).toContain(`document.querySelector('.chat-composer-footer')`);
    expect(composer).toContain('class="chat-composer-footer"');
  });
});
