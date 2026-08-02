import { BadRequestException } from '@nestjs/common';
import {
  isPrivateIpAddress,
  assertPublicAddresses,
  assertSafeExternalUrl,
  ssrfSafeLookup,
  extractIconUrl,
  buildLinkPreviewPayload,
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

  it('flags the wildcard and reserved IPv4 blocks as private', () => {
    for (const ip of [
      // A connection to 0.0.0.0 lands on loopback under Linux, so it reaches
      // every service bound to the wildcard address.
      '0.0.0.0',
      '100.64.0.1', // RFC 6598 carrier-grade NAT
      '192.0.0.1', // RFC 6890 protocol assignments
      '198.18.0.1', // RFC 2544 benchmarking
      '224.0.0.1', // multicast
      '255.255.255.255', // broadcast
    ]) {
      expect(isPrivateIpAddress(ip)).toBe(true);
    }
  });

  it('flags an IPv4-mapped IPv6 loopback in either notation', () => {
    // The socket ends up on the embedded IPv4, so that is what has to be judged.
    // Both spellings denote 127.0.0.1; DNS hands back either one.
    for (const ip of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::127.0.0.1',
      '64:ff9b::127.0.0.1',
      '::ffff:10.0.0.4',
      '::ffff:192.168.1.1',
    ]) {
      expect(isPrivateIpAddress(ip)).toBe(true);
    }
  });

  it('flags the unspecified address and the rest of the link-local IPv6 range', () => {
    // fe80::/10 spans fe80-febf, not just the fe80: hextet.
    for (const ip of ['::', 'fe9a::1', 'feb0::1', 'ff02::1', 'fe80::1%eth0']) {
      expect(isPrivateIpAddress(ip)).toBe(true);
    }
  });

  it('treats public addresses as non-private', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700::1111', '::ffff:1.1.1.1']) {
      expect(isPrivateIpAddress(ip)).toBe(false);
    }
  });

  it('rejects malformed IPv4 defensively (treated as private)', () => {
    for (const ip of ['999.1.1', '999.1.1.1', '1.1.1.-1', 'not.an.ip.at']) {
      expect(isPrivateIpAddress(ip)).toBe(true);
    }
  });
});

describe('assertPublicAddresses', () => {
  it('passes when every resolved address is public', () => {
    expect(() =>
      assertPublicAddresses([{ address: '1.1.1.1' }, { address: '8.8.8.8' }])
    ).not.toThrow();
  });

  it('throws BadRequestException if any resolved address is private', () => {
    expect(() => assertPublicAddresses([{ address: '1.1.1.1' }, { address: '127.0.0.1' }])).toThrow(
      BadRequestException
    );
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
    await expect(assertSafeExternalUrl('ftp://example.com')).rejects.toThrow(BadRequestException);
  });

  it('rejects embedded credentials', async () => {
    await expect(assertSafeExternalUrl('http://user:pass@example.com')).rejects.toThrow(
      BadRequestException
    );
  });

  it('rejects localhost hostnames', async () => {
    await expect(assertSafeExternalUrl('http://localhost/x')).rejects.toThrow(BadRequestException);
  });

  it('rejects literal private IPs before any DNS lookup', async () => {
    await expect(assertSafeExternalUrl('http://127.0.0.1/x')).rejects.toThrow(BadRequestException);
  });

  it('rejects a bracketed IPv6 literal before any DNS lookup', async () => {
    // parsed.hostname keeps the brackets, so without unbracketing isIP() answers
    // "not an address" and the whole literal branch is skipped.
    for (const url of ['http://[::1]/x', 'http://[::ffff:127.0.0.1]/x', 'http://[::]/x']) {
      await expect(assertSafeExternalUrl(url)).rejects.toThrow(BadRequestException);
    }
  });

  it('rejects the wildcard address', async () => {
    await expect(assertSafeExternalUrl('http://0.0.0.0:8080/x')).rejects.toThrow(
      BadRequestException
    );
  });

  it('accepts a public literal IP and returns the parsed URL', async () => {
    const url = await assertSafeExternalUrl('https://1.1.1.1/path');
    expect(url.hostname).toBe('1.1.1.1');
    expect(url.protocol).toBe('https:');
  });
});

describe('extractIconUrl', () => {
  const page = new URL('https://sky.mitv.fr/arbre');

  it('resolves a relative icon href against the page URL', () => {
    const html = '<link rel="icon" href="/favicon.svg">';
    expect(extractIconUrl(html, page)).toBe('https://sky.mitv.fr/favicon.svg');
  });

  it('prefers the largest declared size over the first declaration', () => {
    const html = [
      '<link rel="icon" sizes="16x16" href="/small.png">',
      '<link rel="icon" sizes="192x192" href="/large.png">',
      '<link rel="icon" sizes="32x32" href="/medium.png">',
    ].join('');
    expect(extractIconUrl(html, page)).toBe('https://sky.mitv.fr/large.png');
  });

  it('prefers an apple-touch-icon over a bare sizeless icon', () => {
    const html = '<link rel="icon" href="/f.ico"><link rel="apple-touch-icon" href="/a.png">';
    expect(extractIconUrl(html, page)).toBe('https://sky.mitv.fr/a.png');
  });

  it('accepts the legacy "shortcut icon" rel', () => {
    const html = '<link rel="shortcut icon" href="https://cdn.example.com/i.png">';
    expect(extractIconUrl(html, page)).toBe('https://cdn.example.com/i.png');
  });

  it('ignores an unrelated rel that merely contains the word', () => {
    // "canonical" and "stylesheet" must not be mistaken for icons.
    const html = '<link rel="stylesheet" href="/app.css"><link rel="canonical" href="/x">';
    expect(extractIconUrl(html, page)).toBe('https://sky.mitv.fr/favicon.ico');
  });

  it('falls back to /favicon.ico on the ORIGIN, not the current path', () => {
    expect(extractIconUrl('<html></html>', page)).toBe('https://sky.mitv.fr/favicon.ico');
  });

  it('refuses a non-http scheme, which new URL() resolves rather than rejects', () => {
    // The href reaches an <img src>, and `new URL('javascript:...', base)` does
    // not throw - it keeps the scheme. A bigger declared size must not buy a
    // dangerous scheme its way in either.
    for (const href of ['javascript:alert(1)', 'data:text/html,<script></script>', 'file:///etc']) {
      const html = `<link rel="icon" sizes="512x512" href="${href}"><link rel="icon" href="/ok.png">`;
      expect(extractIconUrl(html, page)).toBe('https://sky.mitv.fr/ok.png');
    }
  });
});

describe('buildLinkPreviewPayload', () => {
  it('carries the icon alongside the Open Graph fields', () => {
    const html = ['<title>Sky</title>', '<link rel="icon" sizes="180x180" href="/icon.png">'].join(
      ''
    );
    const payload = buildLinkPreviewPayload(html, new URL('https://sky.mitv.fr/'));
    expect(payload.title).toBe('Sky');
    expect(payload.icon).toBe('https://sky.mitv.fr/icon.png');
  });
});
