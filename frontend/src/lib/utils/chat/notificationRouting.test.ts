import {
  chatDeepLinkRoute,
  landingAfterRefresh,
  landingRecovery,
  selectionBelongsToRoute,
} from './notificationRouting';

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

describe('landingRecovery', () => {
  it('refreshes the communities for a channel it has never looked up', () => {
    // A just-accepted invitation is never in the loaded sidebar.
    expect(
      landingRecovery({ isChannel: true, alreadyRefreshed: false, conversationsRestored: true })
    ).toBe('refresh');
  });

  it('waits instead of refreshing the same channel twice', () => {
    expect(
      landingRecovery({ isChannel: true, alreadyRefreshed: true, conversationsRestored: true })
    ).toBe('wait');
  });

  it('waits for a DM while the conversations map is still being restored', () => {
    // Clearing the target here is what left a tapped message notification on an empty /chat:
    // the map is emptied and rebuilt wholesale by the IndexedDB restore.
    expect(
      landingRecovery({ isChannel: false, alreadyRefreshed: false, conversationsRestored: false })
    ).toBe('wait');
  });

  it('abandons a DM absent from a settled map', () => {
    expect(
      landingRecovery({ isChannel: false, alreadyRefreshed: false, conversationsRestored: true })
    ).toBe('abandon');
  });
});

describe('landingAfterRefresh', () => {
  it('retries when the refresh never ran', () => {
    // The communities loader declines while one is already in flight, so a join racing the
    // startup load would otherwise wait forever for a refresh nobody performed.
    expect(landingAfterRefresh({ refreshRan: false, targetLoaded: false })).toBe('retry');
  });

  it('waits for the effect to select a target the refresh brought in', () => {
    expect(landingAfterRefresh({ refreshRan: true, targetLoaded: true })).toBe('wait');
  });

  it('abandons a channel still unknown after a real refresh', () => {
    // Revoked access or a deleted community: holding the target would keep the selection
    // watchdog off a conversation that is never coming back.
    expect(landingAfterRefresh({ refreshRan: true, targetLoaded: false })).toBe('abandon');
  });
});
