import { feedHeldForLanding } from './feedLandingHold';

describe('feedHeldForLanding', () => {
  it('holds the first draw while a landing is on its way', () => {
    expect(feedHeldForLanding({ landingEnRoute: true, feedDrawn: false })).toBe(true);
  });

  it('never blanks a feed that is already on screen', () => {
    expect(feedHeldForLanding({ landingEnRoute: true, feedDrawn: true })).toBe(false);
  });

  it('draws once the landing has arrived or been abandoned', () => {
    expect(feedHeldForLanding({ landingEnRoute: false, feedDrawn: false })).toBe(false);
  });
});
