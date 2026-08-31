import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setTabRinging, setTabUnread, startTabIndicator } from './tabIndicator';

/**
 * THE ONE WRITER OF THE TAB'S TITLE, and the two things that used to make a second one unsafe.
 *
 * `useNotifications` blinked a bell by saving `document.title`, overwriting it and restoring the
 * saved copy. Any other party writing the title was therefore captured into that save and reinstated
 * after the call, or erased by the restore. These tests pin the property that replaced it: the title
 * is rendered from (base, unread, bell) every time, so no ordering of unread and ringing can leave a
 * prefix behind - and the route's own title is ADOPTED from the DOM rather than passed in, so a
 * navigation does not have to know this module exists.
 */
describe('the tab indicator', () => {
  /** Lets the `MutationObserver` deliver; it is a microtask, so one turn is enough. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    document.title = 'Canari';
    setTabUnread(0);
    setTabRinging(false);
    startTabIndicator();
  });

  afterEach(() => {
    setTabRinging(false);
    setTabUnread(0);
    vi.useRealTimers();
  });

  it('says nothing until there is something unread', () => {
    expect(document.title).toBe('Canari');
  });

  it('announces the count, and takes the announcement back', () => {
    setTabUnread(4);
    expect(document.title).toBe('(4) Canari');
    setTabUnread(0);
    expect(document.title).toBe('Canari');
  });

  /** THE NAVIGATION CASE. Nothing tells this module a route changed; it reads the title itself. */
  it('adopts a title written by somebody else as the new base', async () => {
    setTabUnread(2);
    expect(document.title).toBe('(2) Canari');

    // What `SeoHead` does on a navigation: it writes the route's own, undecorated title.
    document.title = 'Communautes - Canari';
    await settle();

    expect(document.title).toBe('(2) Communautes - Canari');
  });

  /** The exact interleaving the old save-and-restore blink got wrong. */
  it('gives the tab back to the count when a call stops ringing', () => {
    setTabUnread(7);
    setTabRinging(true);
    expect(document.title).toBe('\u{1F514} Canari');
    setTabRinging(false);
    expect(document.title).toBe('(7) Canari');
  });

  it('keeps a count that arrives DURING a call, and shows it afterwards', () => {
    setTabRinging(true);
    setTabUnread(1);
    expect(document.title).toBe('\u{1F514} Canari');
    setTabRinging(false);
    expect(document.title).toBe('(1) Canari');
  });

  it('blinks the bell while a call rings, and stops the timer when it ends', () => {
    vi.useFakeTimers();
    setTabRinging(true);
    expect(document.title).toBe('\u{1F514} Canari');
    vi.advanceTimersByTime(800);
    expect(document.title).toBe('Canari');
    vi.advanceTimersByTime(800);
    expect(document.title).toBe('\u{1F514} Canari');
    setTabRinging(false);
    expect(document.title).toBe('Canari');
  });

  /**
   * AND THE TIMER ITSELF, because the title cannot answer this one. `ringing` gates the bell, so a
   * blink interval left running after the call ends changes nothing visible and would sit there for
   * the life of the tab, waking it every 800 ms. Asserting the title here passed with the clear
   * removed - the count is what has to be read.
   */
  it('leaves no interval behind when the call ends', () => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    setTabRinging(true);
    expect(vi.getTimerCount()).toBe(before + 1);
    setTabRinging(false);
    expect(vi.getTimerCount()).toBe(before);
  });
});
