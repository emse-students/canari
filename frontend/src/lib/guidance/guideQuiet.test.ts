/** The quiet state: every fact the owner named holds a help back, and nothing else does. */
import { describe, expect, it } from 'vitest';
import { quietBlocker, type QuietFacts } from './guideQuiet';

const QUIET: QuietFacts = {
  signedIn: true,
  authPage: false,
  fullScreenPlace: false,
  screenCovered: false,
  callActive: false,
  keyboardOpen: false,
  otherOverlays: 0,
  routeSettled: true,
  gated: false,
  nativeBarPending: false,
};

describe('quietBlocker', () => {
  it('is null when the app is quiet', () => {
    expect(quietBlocker(QUIET)).toBeNull();
  });

  it.each<[keyof QuietFacts, QuietFacts[keyof QuietFacts]]>([
    ['signedIn', false], // the PIN gate and the login
    ['authPage', true],
    ['fullScreenPlace', true], // the camera
    ['screenCovered', true], // a modal, a sheet, the call screen, the PIN lock
    ['callActive', true], // even minimised to the banner
    ['keyboardOpen', true],
    ['otherOverlays', 1], // a menu on the history stack
    ['routeSettled', false],
    ['gated', true],
    ['nativeBarPending', true],
  ])('holds a help back while %s is %s', (fact, value) => {
    expect(quietBlocker({ ...QUIET, [fact]: value })).not.toBeNull();
  });
});
