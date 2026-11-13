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
    // Both ways a keyboard layout lands: the animated fall or height change, and the rise's snap.
    const completion = native.slice(native.indexOf('completion:^(__unused BOOL finished)'));
    expect(completion.slice(0, 200)).toContain('CanariKeyboardLayoutSettled(webView)');
    const handOff = native.slice(native.indexOf('static void CanariHandKeyboardRiseToPage('));
    expect(handOff.slice(0, handOff.indexOf('\n}\n'))).toContain(
      'CanariKeyboardLayoutSettled(webView)'
    );
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
