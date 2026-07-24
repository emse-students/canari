import { chatDeepLinkRoute } from './notificationRouting';

describe('chatDeepLinkRoute', () => {
  it('routes channel targets to /communities', () => {
    expect(chatDeepLinkRoute('channel_ee943652-f5d0-4550-b74b-b781f8c4d84b')).toBe('/communities');
  });

  it('routes DM/group targets to /chat', () => {
    expect(chatDeepLinkRoute('5f4d0010-1234-4000-8000-000000000000')).toBe('/chat');
    expect(chatDeepLinkRoute('alice::bob')).toBe('/chat');
  });
});
