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
    const scroller = css.slice(at('.chat-messages-scroll {'));
    expect(scroller.slice(0, scroller.indexOf('\n}'))).toContain(
      'padding-bottom: var(--chat-composer-height'
    );
  });
});
