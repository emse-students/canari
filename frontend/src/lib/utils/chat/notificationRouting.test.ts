import { chatDeepLinkRoute, selectionBelongsToRoute } from './notificationRouting';

describe('chatDeepLinkRoute', () => {
  it('routes channel targets to /communities', () => {
    expect(chatDeepLinkRoute('channel_ee943652-f5d0-4550-b74b-b781f8c4d84b')).toBe('/communities');
  });

  it('routes DM/group targets to /chat', () => {
    expect(chatDeepLinkRoute('5f4d0010-1234-4000-8000-000000000000')).toBe('/chat');
    expect(chatDeepLinkRoute('alice::bob')).toBe('/chat');
  });
});

describe('selectionBelongsToRoute', () => {
  const channel = 'channel_ee943652-f5d0-4550-b74b-b781f8c4d84b';
  const dm = '5f4d0010-1234-4000-8000-000000000000';

  it('keeps a channel deep-linked into /communities', () => {
    // The invite card, the invite link and a channel notification all publish this selection
    // right before navigating; the route-mode reset must not wipe it on arrival.
    expect(selectionBelongsToRoute(channel, 'communities')).toBe(true);
  });

  it('keeps a DM deep-linked into /chat', () => {
    expect(selectionBelongsToRoute(dm, 'chat')).toBe(true);
  });

  it('discards the previous tab selection on a genuine mode switch', () => {
    expect(selectionBelongsToRoute(channel, 'chat')).toBe(false);
    expect(selectionBelongsToRoute(dm, 'communities')).toBe(false);
  });

  it('treats no selection as nothing to preserve', () => {
    expect(selectionBelongsToRoute(null, 'communities')).toBe(false);
    expect(selectionBelongsToRoute('', 'chat')).toBe(false);
  });
});
