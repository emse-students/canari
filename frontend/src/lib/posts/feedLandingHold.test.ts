import { feedHeldForLanding } from './feedLandingHold';

describe('feedHeldForLanding', () => {
  it('holds the first draw while a landing is pending', () => {
    expect(feedHeldForLanding({ landingPending: true, feedDrawn: false })).toBe(true);
  });

  it('never blanks a feed that is already on screen', () => {
    expect(feedHeldForLanding({ landingPending: true, feedDrawn: true })).toBe(false);
  });

  it('draws as before when no landing is pending, including after one is abandoned', () => {
    expect(feedHeldForLanding({ landingPending: false, feedDrawn: false })).toBe(false);
    expect(feedHeldForLanding({ landingPending: false, feedDrawn: true })).toBe(false);
  });
});
