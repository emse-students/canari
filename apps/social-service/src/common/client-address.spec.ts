import { Logger } from '@nestjs/common';
import { clientAddress, visitorNetwork } from './client-address';
import { ClientIpThrottlerGuard } from './guards/client-ip-throttler.guard';

describe('the visitor behind a request', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  // Control (2026-10-22): `visitorNetwork` returning its input -> the IPv6 cases fail.
  it.each([
    ['2001:db8:1234:5678:aaaa:bbbb:cccc:dddd', '2001:0db8:1234:5678::/64'],
    ['2001:db8:1234:5678::1', '2001:0db8:1234:5678::/64'],
    ['2001:DB8:1234:5678:0:0:0:2', '2001:0db8:1234:5678::/64'],
    ['fe80::1%eth0', 'fe80:0000:0000:0000::/64'],
    ['::', '0000:0000:0000:0000::/64'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    ['2001:db8::203.0.113.7', '2001:0db8:0000:0000::/64'],
    ['203.0.113.7', '203.0.113.7'],
    ['not-an-address', 'not-an-address'],
  ])('keys %s as %s', (address, network) => {
    expect(visitorNetwork(address)).toBe(network);
  });

  it('counts every address of one IPv6 /64 as ONE visitor, and two /64s as two', () => {
    const one = clientAddress({ headers: { 'x-real-ip': '2001:db8:1:2:aaaa::1' } });
    const sameNetwork = clientAddress({ headers: { 'x-real-ip': '2001:db8:1:2:ffff::9' } });
    const otherNetwork = clientAddress({ headers: { 'x-real-ip': '2001:db8:1:3::1' } });
    expect(sameNetwork).toBe(one);
    expect(otherNetwork).not.toBe(one);
  });

  it('keys the throttle on the same network', async () => {
    const guard = Object.create(ClientIpThrottlerGuard.prototype) as {
      getTracker(req: unknown): Promise<string>;
    };
    await expect(
      guard.getTracker({ headers: { 'x-real-ip': '2001:db8:1:2:aaaa::1' } })
    ).resolves.toBe('2001:0db8:0001:0002::/64');
  });

  it('keys a request that did not come through nginx on its socket, said out loud', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(clientAddress({ ip: '2001:db8:9:9::5', method: 'POST', url: '/x' })).toBe(
      '2001:0db8:0009:0009::/64'
    );
    expect(warn).toHaveBeenCalled();
  });
});
