import { ApiRefusalError } from '$lib/utils/apiRefusal';
import { feedAudienceState, setFeedAudience } from '$lib/stores/userState.svelte';
import { isFeedAudienceRefusal, isOutsideFeedAudience } from './feedAudience';

/**
 * FEED_GATE: a reader with no space and no association is REFUSED by `FeedAudienceGuard` with a
 * 403, and the posts page used to render that as the generic "could not load posts". A 403 is an
 * answer about the reader; it is classified by status, never by the guard's sentence.
 */
describe('a refused feed read is a verdict, not a failure', () => {
  it('classifies a 403 by status and nothing else', () => {
    expect(isFeedAudienceRefusal(new ApiRefusalError(403, null, 'anything'))).toBe(true);
    expect(isFeedAudienceRefusal(new ApiRefusalError(500, null, 'forbidden'))).toBe(false);
    expect(isFeedAudienceRefusal(new ApiRefusalError(401, null, 'x'))).toBe(false);
    expect(isFeedAudienceRefusal(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('corrects the remembered verdict on a 403 only', () => {
    setFeedAudience(true);
    expect(isOutsideFeedAudience(new ApiRefusalError(503, null, 'down'))).toBe(false);
    expect(feedAudienceState()).toBe(true);
    expect(isOutsideFeedAudience(new ApiRefusalError(403, null, 'refused'))).toBe(true);
    expect(feedAudienceState()).toBe(false);
  });
});
