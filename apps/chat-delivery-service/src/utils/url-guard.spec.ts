import { BadRequestException, Logger } from '@nestjs/common';
import {
  isPrivateIpAddress,
  assertPublicAddresses,
  assertSafeExternalUrl,
  ssrfSafeLookup,
  ssrfSafeFetch,
  errorCause,
  extractIconUrl,
  buildLinkPreviewPayload,
  decodeHtmlEntity,
  extractOEmbedEndpoint,
  mergeOEmbedIntoPayload,
  galleryWideCoverFor,
  fetchMiGalleryPreview,
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

describe('ssrfSafeFetch', () => {
  it('gets as far as the SSRF guard, i.e. the runtime accepted the dispatcher', async () => {
    // Regression guard: the dispatcher and the fetch that consumes it must come
    // from the SAME undici copy. Handing Node's global fetch an `undici` Agent
    // raised InvalidArgumentError ("invalid onRequestStart method") before any
    // connection, which silently broke every link preview.
    // A host name (not an IP literal) is required: net.connect skips the lookup
    // for a literal, and the lookup is what this asserts ran.
    const error = await ssrfSafeFetch('http://localhost:44444/').then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(TypeError);
    const cause = errorCause(error) as NodeJS.ErrnoException | undefined;
    // ESSRFBLOCKED = our lookup ran and refused. Any other code (notably
    // UND_ERR_INVALID_ARG) means the request died before reaching it.
    expect(cause?.code).toBe('ESSRFBLOCKED');
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

describe('extractOEmbedEndpoint', () => {
  const page = new URL('https://open.spotify.com/track/abc');

  it('finds the JSON oEmbed declaration and resolves it absolutely', () => {
    const html = '<link rel="alternate" type="application/json+oembed" href="/oembed?url=track">';
    expect(extractOEmbedEndpoint(html, page)).toBe('https://open.spotify.com/oembed?url=track');
  });

  it('accepts the legacy text/json+oembed type', () => {
    const html = '<link rel="alternate" type="text/json+oembed" href="https://x.test/o.json">';
    expect(extractOEmbedEndpoint(html, page)).toBe('https://x.test/o.json');
  });

  it('ignores the XML flavour, which we cannot parse', () => {
    const html = '<link rel="alternate" type="text/xml+oembed" href="/o.xml">';
    expect(extractOEmbedEndpoint(html, page)).toBeNull();
  });

  it('ignores an alternate that is not oEmbed at all', () => {
    const html = '<link rel="alternate" type="application/rss+xml" href="/feed">';
    expect(extractOEmbedEndpoint(html, page)).toBeNull();
  });

  it('refuses a non-http scheme, which new URL() resolves rather than rejects', () => {
    // Same trap as extractIconUrl: this href becomes an outbound fetch.
    const html = '<link rel="alternate" type="application/json+oembed" href="javascript:alert(1)">';
    expect(extractOEmbedEndpoint(html, page)).toBeNull();
  });
});

describe('mergeOEmbedIntoPayload', () => {
  const page = new URL('https://vimeo.com/12345');
  const base = {
    url: page.toString(),
    title: 'Real og:title',
    description: 'Real og:description',
    image: 'https://vimeo.com/og.jpg',
    siteName: 'Vimeo',
  };

  it('leaves a payload untouched when there is no oEmbed data', () => {
    expect(mergeOEmbedIntoPayload(base, null, page)).toEqual(base);
  });

  it('never overwrites what the page already declared', () => {
    const merged = mergeOEmbedIntoPayload(
      base,
      { title: 'oEmbed title', authorName: 'Someone', thumbnailUrl: 'https://x.test/t.jpg' },
      page
    );
    expect(merged.title).toBe('Real og:title');
    expect(merged.description).toBe('Real og:description');
    expect(merged.image).toBe('https://vimeo.com/og.jpg');
  });

  it('supplies the title only when the page fell back to its hostname', () => {
    const bare = { ...base, title: page.hostname };
    expect(mergeOEmbedIntoPayload(bare, { title: 'oEmbed title' }, page).title).toBe(
      'oEmbed title'
    );
  });

  it('turns the author into a description when the page has none', () => {
    const merged = mergeOEmbedIntoPayload(
      { ...base, description: '' },
      { authorName: 'Alice', providerName: 'Vimeo' },
      page
    );
    expect(merged.description).toBe('Vimeo • Alice');
  });

  it('uses the oEmbed thumbnail when the page declared no og:image', () => {
    const merged = mergeOEmbedIntoPayload(
      { ...base, image: '' },
      { thumbnailUrl: '/thumb.jpg' },
      page
    );
    expect(merged.image).toBe('https://vimeo.com/thumb.jpg');
  });

  it('refuses a thumbnail whose scheme cannot reach an <img src>', () => {
    const merged = mergeOEmbedIntoPayload(
      { ...base, image: '' },
      { thumbnailUrl: 'javascript:alert(1)' },
      page
    );
    expect(merged.image).toBe('');
  });

  it('names the provider only where the site name was just the hostname', () => {
    const bare = { ...base, siteName: page.hostname };
    expect(mergeOEmbedIntoPayload(bare, { providerName: 'Vimeo' }, page).siteName).toBe('Vimeo');
    expect(mergeOEmbedIntoPayload(base, { providerName: 'Other' }, page).siteName).toBe('Vimeo');
  });
});

describe('link-preview entity decoding', () => {
  const url = new URL('https://www.deezer.com/track/1');
  const preview = (html: string) => buildLinkPreviewPayload(html, url);

  it('decodes named and numeric references in og:title, description and site name', () => {
    const html = [
      '<meta property="og:title" content="C&rsquo;est la vie &eacute; &#8217; &#x2019;">',
      '<meta property="og:description" content="Caf&eacute; &amp; cr&egrave;me">',
      '<meta property="og:site_name" content="Deezer&nbsp;&rsquo;s">',
    ].join('');
    const p = preview(html);
    expect(p.title).toBe('C’est la vie é ’ ’');
    expect(p.description).toBe('Café & crème');
    expect(p.siteName).toBe('Deezer ’s');
  });

  it('decodes a <title> fallback too', () => {
    expect(preview('<title>C&rsquo;est la vie</title>').title).toBe('C’est la vie');
  });

  it('decodes exactly once: &amp;rsquo; becomes the literal &rsquo;', () => {
    expect(decodeHtmlEntity('&amp;rsquo;')).toBe('&rsquo;');
    expect(decodeHtmlEntity('&amp;lt;')).toBe('&lt;');
  });

  it('turns &lt;script&gt; into inert text, never markup', () => {
    expect(decodeHtmlEntity('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe(
      '<script>alert(1)</script>'
    );
  });

  it('leaves an unknown entity as written', () => {
    expect(decodeHtmlEntity('a &notanentity; b')).toBe('a &notanentity; b');
  });
});

describe('MiGallery album cover', () => {
  const ORIGIN = 'https://gallery.mitv.fr';
  const ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

  it('offers the wide 1200x630 cover, MiGallery serving it without a key for every album', () => {
    expect(galleryWideCoverFor(ORIGIN, ID)).toBe(`${ORIGIN}/api/albums/${ID}/og-cover`);
  });

  describe('fetchMiGalleryPreview', () => {
    const realFetch = global.fetch;
    const realKey = process.env.MIGALLERY_API_KEY;
    const realBase = process.env.MIGALLERY_API_URL;
    let warn: jest.SpyInstance;
    let error: jest.SpyInstance;
    let fetchMock: jest.Mock;

    beforeEach(() => {
      process.env.MIGALLERY_API_KEY = 'test-key';
      delete process.env.MIGALLERY_API_URL;
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
      global.fetch = realFetch;
      warn.mockRestore();
      error.mockRestore();
      if (realKey === undefined) delete process.env.MIGALLERY_API_KEY;
      else process.env.MIGALLERY_API_KEY = realKey;
      if (realBase === undefined) delete process.env.MIGALLERY_API_URL;
      else process.env.MIGALLERY_API_URL = realBase;
    });

    /** MiGallery answers `status` with `body` to every request. */
    function answerWith(status: number, body: unknown) {
      fetchMock = jest.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      }));
      global.fetch = fetchMock as unknown as typeof fetch;
    }

    const preview = () => fetchMiGalleryPreview(new URL(`${ORIGIN}/albums/${ID}`));
    const logged = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0])).join('\n');

    it('reads the read-scoped preview route, never /info', async () => {
      answerWith(200, { name: 'Gala', date: '2026-05-15', visibility: 'unlisted' });
      await preview();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe(`${ORIGIN}/api/albums/${ID}/preview`);
      expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('test-key');
    });

    it('gives a PRIVATE album its whole card: title, date and place, and the wide cover', async () => {
      answerWith(200, {
        name: 'Gala',
        date: '2026-05-15',
        location: 'Saint-Etienne',
        visibility: 'private',
      });
      expect(await preview()).toEqual({
        url: `${ORIGIN}/albums/${ID}`,
        title: 'Gala',
        description: '15 mai 2026 · Saint-Etienne',
        image: `${ORIGIN}/api/albums/${ID}/og-cover`,
        siteName: 'MiGallery',
      });
    });

    it('accuses a refused key at ERROR, naming the read scope and the status', async () => {
      answerWith(403, { message: 'Read, Write or Admin scope required' });
      expect(await preview()).toBeNull();
      expect(logged(error)).toMatch(/refused the album preview \(403\).*read scope/);
    });

    it('tells a MiGallery with no preview route from an album it does not know', async () => {
      answerWith(404, { message: 'Not Found' });
      expect(await preview()).toBeNull();
      expect(logged(warn)).toContain('MiGallery has no preview route yet');

      warn.mockClear();
      answerWith(404, { code: 'album_not_found', message: 'Album not found' });
      expect(await preview()).toBeNull();
      expect(logged(warn)).toContain(`MiGallery knows no album ${ID}`);
      expect(logged(warn)).not.toContain('no preview route');
    });

    it('logs any other status, a nameless answer and an unreachable MiGallery at WARN', async () => {
      answerWith(502, {});
      expect(await preview()).toBeNull();
      expect(logged(warn)).toContain('answered 502');

      answerWith(200, { visibility: 'private' });
      expect(await preview()).toBeNull();
      expect(logged(warn)).toContain('carried no name');

      global.fetch = jest.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }) as unknown as typeof fetch;
      expect(await preview()).toBeNull();
      expect(logged(warn)).toContain('unreachable');
    });

    it('leaves a URL that is not an album link to the page path, without a request', async () => {
      answerWith(200, { name: 'Gala' });
      expect(await fetchMiGalleryPreview(new URL(`${ORIGIN}/albums`))).toBeNull();
      expect(await fetchMiGalleryPreview(new URL(`https://example.org/albums/${ID}`))).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
