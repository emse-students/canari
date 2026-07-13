import { BadRequestException } from '@nestjs/common';
import {
  isPrivateIpAddress,
  assertPublicAddresses,
  assertSafeExternalUrl,
  ssrfSafeLookup,
} from './url-guard';

describe('isPrivateIpAddress', () => {
  it('flags loopback, RFC-1918 and link-local IPv4 as private', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.4',
      '172.16.3.9',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.10.10',
    ]) {
      expect(isPrivateIpAddress(ip)).toBe(true);
    }
  });

  it('flags loopback and unique-local/link-local IPv6 as private', () => {
    for (const ip of ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1']) {
      expect(isPrivateIpAddress(ip)).toBe(true);
    }
  });

  it('treats public addresses as non-private', () => {
    for (const ip of [
      '1.1.1.1',
      '8.8.8.8',
      '93.184.216.34',
      '2606:4700::1111',
    ]) {
      expect(isPrivateIpAddress(ip)).toBe(false);
    }
  });

  it('rejects malformed IPv4 defensively (treated as private)', () => {
    expect(isPrivateIpAddress('999.1.1')).toBe(true);
  });
});

describe('assertPublicAddresses', () => {
  it('passes when every resolved address is public', () => {
    expect(() =>
      assertPublicAddresses([{ address: '1.1.1.1' }, { address: '8.8.8.8' }]),
    ).not.toThrow();
  });

  it('throws BadRequestException if any resolved address is private', () => {
    expect(() =>
      assertPublicAddresses([{ address: '1.1.1.1' }, { address: '127.0.0.1' }]),
    ).toThrow(BadRequestException);
  });
});

describe('ssrfSafeLookup', () => {
  // dns.lookup resolves IP literals without any network access, so these
  // exercise the private-address barrier deterministically offline.
  it('errors (ESSRFBLOCKED) when the host resolves to a private address', (done) => {
    ssrfSafeLookup('127.0.0.1', { all: true }, (err) => {
      expect(err).toBeTruthy();
      expect(err?.code).toBe('ESSRFBLOCKED');
      done();
    });
  });

  it('returns the address array when all:true and the address is public', (done) => {
    ssrfSafeLookup('1.1.1.1', { all: true }, (err, address) => {
      expect(err).toBeNull();
      expect(address).toEqual([{ address: '1.1.1.1', family: 4 }]);
      done();
    });
  });

  it('returns (address, family) when all is not set', (done) => {
    ssrfSafeLookup('1.1.1.1', {}, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe('1.1.1.1');
      expect(family).toBe(4);
      done();
    });
  });
});

describe('assertSafeExternalUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertSafeExternalUrl('ftp://example.com')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects embedded credentials', async () => {
    await expect(
      assertSafeExternalUrl('http://user:pass@example.com'),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects localhost hostnames', async () => {
    await expect(assertSafeExternalUrl('http://localhost/x')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects literal private IPs before any DNS lookup', async () => {
    await expect(assertSafeExternalUrl('http://127.0.0.1/x')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('accepts a public literal IP and returns the parsed URL', async () => {
    const url = await assertSafeExternalUrl('https://1.1.1.1/path');
    expect(url.hostname).toBe('1.1.1.1');
    expect(url.protocol).toBe('https:');
  });
});
