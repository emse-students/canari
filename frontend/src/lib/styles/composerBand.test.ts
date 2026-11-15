/**
 * THE BAND BEHIND THE COMPOSER MUST BE THE THREAD'S OWN GROUND, AND NOTHING HERE CAN MEASURE COLOUR.
 *
 * The user's report, 2026-09-18: *"le fait que l'on puisse avoir des messages ou reactions derriere
 * la barre de saisie est moche"*. The list already RESERVES the composer's height with
 * `padding-bottom`, so a thread at rest ends above the bar - what showed through was everything
 * passing behind it MID-SCROLL, which no padding can reach. The fix is an opaque fill, and the fill
 * has to be the SAME colour as the ground it sits on: any other value is a new surface, which the
 * 2026-09-14 pass removed from this exact spot and must not come back.
 *
 * Two things can go wrong silently and neither is visible to `check`, `lint` or a rendered test:
 *
 * 1. **A SECOND SPELLING OF ONE COLOUR DRIFTS.** `--cn-bg` moved once already (the palette went OLED
 *    while three literals in `app.html` stayed `#1f1f1f`), and a band written as its own token would
 *    part company with the thread the next time. So the band names the variable, never a colour.
 * 2. **SOURCE ORDER DECIDES THE BREAKPOINT.** The ground is `--cn-bg` below 768px and `--cn-surface`
 *    above it, where the panel becomes a card. Two rules one class deep are settled by which comes
 *    LAST, so an override written above its base silently loses - that has shipped here before (the
 *    28px hover strip measuring 38px). The order is asserted rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.css'),
  'utf8'
);

/** Index of a declaration, or -1. */
const at = (needle: string) => css.indexOf(needle);

describe('the composer band', () => {
  it('is filled from the thread ground variable, never from a colour of its own', () => {
    const footer = css.slice(at('.chat-composer-footer {'));
    const body = footer.slice(0, footer.indexOf('\n}'));
    expect(body).toContain('background: var(--chat-thread-ground');
    expect(body).not.toMatch(/background:\s*transparent/);
    // No literal and no second token: a colour spelt twice is a colour that drifts.
    expect(body).not.toMatch(/background:\s*(#|rgb|oklch|var\(--cn-)/);
  });

  it('takes the app background below 768px and the card surface above it', () => {
    expect(css).toContain('--chat-thread-ground: var(--cn-bg);');
    expect(css).toContain('--chat-thread-ground: var(--cn-surface);');
  });

  /**
   * The base declaration must come FIRST and the breakpoint override LAST, or the card width keeps
   * the phone's ground. Both are unlayered, so nothing but source order separates them.
   */
  it('declares the mobile ground before the 768px override, so the override wins', () => {
    const mobile = at('--chat-thread-ground: var(--cn-bg);');
    const desktop = at('--chat-thread-ground: var(--cn-surface);');
    expect(mobile).toBeGreaterThan(-1);
    expect(desktop).toBeGreaterThan(mobile);
  });

  it('paints the desktop panel from the same variable, so the two can never disagree', () => {
    const desktop = css.slice(at('--chat-thread-ground: var(--cn-surface);'));
    expect(desktop.slice(0, 200)).toContain('background: var(--chat-thread-ground)');
  });

  /**
   * THE RESERVED HEIGHT IS NOT REPLACED BY THE FILL, IT IS THE OTHER HALF OF THE ANSWER. Without it
   * the thread would END behind an opaque bar instead of passing behind it - the last message
   * permanently hidden rather than occasionally overlapped, which is worse than the report.
   */
  it('keeps reserving the composer height, so the thread still ends above the bar at rest', () => {
    // The rule of its own, not the one that resolves the floor on it and the footer.
    const scroller = css.slice(css.indexOf('\n\n.chat-messages-scroll {'));
    // The keyboard's room is added to it (Android's layout inset, 0 elsewhere - keyboard ride).
    expect(scroller.slice(0, scroller.indexOf('\n}'))).toMatch(
      /padding-bottom: (calc\(\s*)?var\(--chat-composer-height/
    );
  });
});

describe('the thread panel on desktop', () => {
  /** `hidden` is still a scroll container; a descendant scrollIntoView moved it (BIG-2, 1.4.1 alpha.5). */
  it('clips instead of hiding, so no programmatic scroll can move the header off-screen', () => {
    const from = css.indexOf('--chat-thread-ground: var(--cn-surface);');
    const block = css.slice(css.lastIndexOf('.chat-thread-panel {', from), from);
    expect(block).toContain('overflow: clip;');
    expect(block).not.toContain('overflow: hidden');
  });

  /**
   * A KEYBOARD MOVE CHANGES THE THREAD'S BOTTOM IN ONE STYLE PASS (review of #3556, D2). The floor
   * moves when the bottom safe area is pinned for a keyboard; `--chat-composer-height` is published a
   * frame late and leaves the floor out (`composerHeight.ts`), so every footer floor and every thread
   * padding must name the same `--chat-composer-floor` - a raw `max(0.75rem, ...)` in either is the
   * 12 px step under the ride.
   */
  it('names one floor in the footer and in the thread padding', () => {
    // Resolved on the two pieces that read it, from the leaf channel's twin first (the keyboard's
    // announcement writes it on them) and the root's safe area otherwise.
    expect(css).toMatch(
      /\.chat-composer-footer,\s*\.chat-messages-scroll\s*\{\s*--chat-composer-floor:\s*max\(\s*0\.75rem,\s*var\(--keyboard-leaf-safe-area-inset-bottom, var\(--safe-area-inset-bottom, 0px\)\)\s*\);/
    );
    const rules = css
      .split('\n}')
      .filter((r) => /\.chat-(composer-footer|messages-scroll)[^{]*\{/.test(r));
    const footers = rules.filter((r) => /\.chat-composer-footer[^{]*\{[^}]*padding-bottom/.test(r));
    const threads = rules.filter((r) => /\.chat-messages-scroll\s*\{[^}]*padding-bottom/.test(r));
    expect(footers.length).toBeGreaterThan(2);
    expect(threads.length).toBeGreaterThan(2);
    for (const rule of footers) {
      expect(rule).not.toMatch(/padding-bottom:\s*max\(0\.75rem/);
    }
    for (const rule of threads) {
      expect(rule).toMatch(
        /padding-bottom:\s*calc\([^;]*var\(--chat-composer-floor\)[^;]*var\(--chat-keyboard-room\)/
      );
    }
    // The GIF panel's 0 is said to both pieces, where the floor is resolved.
    expect(css).toMatch(
      /\.chat-thread-panel:has\(\.chat-composer-footer\.has-keyboard-panel\)\s*:is\(\.chat-composer-footer, \.chat-messages-scroll\)\s*\{\s*--chat-composer-floor:\s*0px;/
    );
  });

  /**
   * THE LEAF CHANNEL (keyboard-and-send-motion.md, section 6): the twins the keyboard's announcement
   * writes on a riding piece, and the terms resolved from them, are registered NOT inherited - an
   * inherited one written on the thread's scroller restyled its 840 descendants (20 ms, as much as a
   * `:root` write), a non-inherited one restyles the scroller alone (0.1 ms).
   */
  it('registers the leaf twins and the terms resolved from them as not inherited', () => {
    for (const name of [
      '--keyboard-leaf-layout-inset-bottom',
      '--keyboard-leaf-occlusion-bottom',
      '--keyboard-leaf-safe-area-inset-bottom',
      '--chat-composer-floor',
      '--chat-keyboard-room',
    ]) {
      expect(css).toMatch(
        new RegExp(`@property ${name} \\{\\s*syntax: '\\*';\\s*inherits: false;\\s*\\}`)
      );
    }
    expect(css).toMatch(
      /--chat-keyboard-room: var\(\s*--keyboard-leaf-layout-inset-bottom,\s*var\(--keyboard-layout-inset-bottom, 0px\)\s*\);/
    );
  });
});
