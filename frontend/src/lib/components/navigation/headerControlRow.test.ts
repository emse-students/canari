/**
 * THE DESKTOP TOP BAR'S RIGHT-HAND CONTROLS SIT ON ONE CENTRE LINE (owner, 2026-11-16).
 *
 * The launcher and the sign-out were 38px `.ui-icon-button` boxes while the avatar was a bare 24px
 * `tap-target` button: an inline button around an inline-flex span grows a line-box gap (measured
 * 24x31 at 1280px, glyph centre 32 against 35.5), so the avatar sat higher and smaller than its
 * neighbours, and the two glyphs were 22 and 20px. A layout engine is not available here, so the
 * test holds the CAUSE: every control of the row is the one shared box, and both glyphs are one size.
 * The measured result (all three 38x38 at 1280px, 44x44 on touch, centres identical, glyphs 22) is in
 * docs/wiki/frontend/design-reference.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
const navbar = read('Navbar.svelte');
const session = read('SessionActionButtons.svelte');
const launcher = read('EcosystemLauncher.svelte');

describe('the desktop top bar control row', () => {
  it('draws the avatar button in the shared icon-button box, not as a bare tap target', () => {
    const avatarButton = navbar.slice(navbar.indexOf("goto('/profile')"));
    expect(avatarButton).toMatch(/class="ui-icon-button /);
    expect(avatarButton).not.toMatch(/class="tap-target /);
  });

  it('keeps the connection ring a box-shadow, so it cannot change the row', () => {
    expect(navbar).toContain('ring-2');
    expect(navbar).not.toMatch(/\bborder-2\b|\boutline-2 ring/);
  });

  it('draws the launcher and the sign-out in the same box and at the same glyph size', () => {
    expect(launcher).toMatch(/class="ui-icon-button /);
    expect(session).toMatch(/class="ui-icon-button /);
    const grip = launcher.match(/<Grip size=\{(\d+)\} strokeWidth=\{([\d.]+)\}/);
    const logOut = session.match(/<LogOut size=\{(\d+)\} strokeWidth=\{([\d.]+)\}/);
    expect(grip).not.toBeNull();
    expect(logOut).not.toBeNull();
    expect(logOut![1]).toBe(grip![1]);
    expect(logOut![2]).toBe(grip![2]);
  });
});
