import { notifNav } from './notifNav.svelte';

/**
 * `enRoute` is what the feed's first-draw hold waits on, so every way a landing stops being on its
 * way must turn it false - or the feed shows skeletons for ever. The target itself stays PENDING
 * after arrival (it is held until displayed, and on a wide screen nothing releases it when the reader
 * leaves `/chat`), which is exactly why `pending` alone cannot be the release.
 */
describe('notifNav.enRoute', () => {
  beforeEach(() => notifNav.clear());

  it('is false with no landing', () => {
    expect(notifNav.enRoute).toBe(false);
  });

  it('is true once a target is published and its route not reached', () => {
    notifNav.navigate('g1');
    expect(notifNav.enRoute).toBe(true);
  });

  it('turns false on arrival although the target stays pending (wide screen, success)', () => {
    notifNav.navigate('g1');
    notifNav.markArrived();
    expect(notifNav.pending).toBe('g1');
    expect(notifNav.enRoute).toBe(false);
  });

  it('turns false when the landing is abandoned before arriving', () => {
    notifNav.navigate('g1');
    notifNav.clear();
    expect(notifNav.enRoute).toBe(false);
  });

  it('is true again for a NEW tap after an earlier landing arrived, same target included', () => {
    notifNav.navigate('g1');
    notifNav.markArrived();
    notifNav.navigate('g1');
    expect(notifNav.enRoute).toBe(true);
  });
});
