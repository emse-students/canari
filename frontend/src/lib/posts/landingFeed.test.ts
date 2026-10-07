import { feedToShowAfterPublish, landingFeedFor } from './landingFeed';

describe('landingFeedFor', () => {
  it('sends an association post to Associations and a personal one to All', () => {
    expect(landingFeedFor({ asAssociation: true, scheduled: false })).toBe('associations');
    expect(landingFeedFor({ asAssociation: false, scheduled: false })).toBe('all');
  });

  it('lands a scheduled post nowhere: no feed shows it yet', () => {
    expect(landingFeedFor({ asAssociation: false, scheduled: true })).toBeNull();
    expect(landingFeedFor({ asAssociation: true, scheduled: true })).toBeNull();
  });
});

describe('feedToShowAfterPublish', () => {
  it('moves a reader off the Associations tab to see their personal post', () => {
    expect(feedToShowAfterPublish('associations', 'all')).toBe('all');
  });

  it('moves a reader on Followed to the feed holding the post', () => {
    expect(feedToShowAfterPublish('followed', 'associations')).toBe('associations');
    expect(feedToShowAfterPublish('followed', 'all')).toBe('all');
  });

  it('keeps a reader on All, and on the feed the post lands in', () => {
    expect(feedToShowAfterPublish('all', 'associations')).toBeNull();
    expect(feedToShowAfterPublish('associations', 'associations')).toBeNull();
  });

  it('never moves anyone for a scheduled post', () => {
    expect(feedToShowAfterPublish('associations', null)).toBeNull();
  });
});
