/// <reference types="jest" />

import { readdirSync, readFileSync, statSync } from 'fs';
import { join as joinPath, resolve, sep } from 'path';
import { chatDeliveryUrl, mediaUrl, socialUrl } from './service-urls';

/**
 * THE LAST TEST IS THE ONE THAT MATTERS: a production source that names an internal service's base
 * URL fails the suite, whatever reads it.
 *
 * This service needed it most. It had the seam AND a second address for the same callee -
 * `getSocialServiceBase()` in `payment/social-internal-client.ts` - plus a third environment name,
 * `SOCIAL_SERVICE_URL`, on the Stripe and Lydia fulfilment paths, which **production has never set
 * for core-service**. Every call took the literal default beside it. Nothing was broken and
 * nothing could be: three ways to say the same hostname all said it.
 */
const SRC = resolve(__dirname, '..');

/** Every internal base this service names - not the ones some past defect happened to involve. */
const INTERNAL_BASES = [
  'CHAT_DELIVERY_URL',
  'SOCIAL_URL',
  'FORM_URL',
  'FORM_SERVICE_URL',
  'SOCIAL_SERVICE_URL',
  'MEDIA_SERVICE_URL',
];

/** Every PRODUCTION `.ts` under `src/`: no specs, and not this module itself. */
function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = joinPath(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'migrations') continue;
      out.push(...productionSources(full));
      continue;
    }
    if (!name.endsWith('.ts') || name.endsWith('.spec.ts')) continue;
    if (name === 'service-urls.ts') continue;
    out.push(full);
  }
  return out;
}

describe("service-urls - the prefix is not the caller's to write", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of INTERNAL_BASES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('inserts the global prefix the environment variable does not carry', () => {
    delete process.env.MEDIA_SERVICE_URL;
    expect(mediaUrl('media/internal/users/abc')).toBe(
      'http://media-service:3011/api/media/internal/users/abc'
    );
  });

  it('addresses chat-delivery-service the same way', () => {
    delete process.env.CHAT_DELIVERY_URL;
    expect(chatDeliveryUrl('internal/users/abc')).toBe(
      'http://chat-delivery-service:3010/api/internal/users/abc'
    );
  });

  it('prefers SOCIAL_URL, then FORM_URL, then FORM_SERVICE_URL', () => {
    delete process.env.SOCIAL_URL;
    delete process.env.FORM_URL;
    process.env.FORM_SERVICE_URL = 'http://only-this-one:3014';
    expect(socialUrl('internal/follows/between/a/b')).toBe(
      'http://only-this-one:3014/api/internal/follows/between/a/b'
    );
    process.env.FORM_URL = 'http://second:3014';
    expect(socialUrl('x')).toBe('http://second:3014/api/x');
    process.env.SOCIAL_URL = 'http://first:3014';
    expect(socialUrl('x')).toBe('http://first:3014/api/x');
  });

  it('does not double the prefix when an operator has already appended it', () => {
    process.env.MEDIA_SERVICE_URL = 'http://media-service:3011/api';
    expect(mediaUrl('media/abc')).toBe('http://media-service:3011/api/media/abc');
  });

  it('tolerates a trailing slash on the base and a leading one on the path', () => {
    process.env.MEDIA_SERVICE_URL = 'http://media-service:3011///';
    expect(mediaUrl('///media/abc')).toBe('http://media-service:3011/api/media/abc');
  });

  /**
   * INHERITED FROM `parseSafeServiceOrigin`, which guarded two calls out of nine. It now runs on
   * every internal URL this service builds - the point of moving it here rather than deleting it
   * with the call sites it was attached to.
   */
  describe('an operator mistake in a compose file fails loudly, at the first call', () => {
    it('refuses a base that is not a URL at all', () => {
      process.env.MEDIA_SERVICE_URL = 'media service';
      expect(() => mediaUrl('media/abc')).toThrow(/MEDIA_SERVICE_URL is not a URL/);
    });

    /**
     * The likeliest mistake of all, and it does NOT reach the parse branch: `new URL` reads
     * `media-service:` as a scheme and succeeds. It is refused one check later, which is the
     * reason both checks exist rather than just the first.
     */
    it('refuses a host:port with the scheme left off', () => {
      process.env.MEDIA_SERVICE_URL = 'media-service:3011';
      expect(() => mediaUrl('media/abc')).toThrow(/must use http or https/);
    });

    it('refuses a scheme that is not http or https', () => {
      process.env.MEDIA_SERVICE_URL = 'file:///etc/passwd';
      expect(() => mediaUrl('media/abc')).toThrow(/must use http or https/);
    });

    it('refuses credentials embedded in the base, which the URL would then be logged with', () => {
      process.env.MEDIA_SERVICE_URL = 'http://user:hunter2@media-service:3011';
      expect(() => mediaUrl('media/abc')).toThrow(/must not include credentials/);
    });
  });

  it('is the ONLY place a production source names an internal base URL', () => {
    const offenders: string[] = [];
    for (const file of productionSources(SRC)) {
      const source = readFileSync(file, 'utf8');
      if (INTERNAL_BASES.some((name) => source.includes(name))) {
        offenders.push(
          file
            .slice(SRC.length + 1)
            .split(sep)
            .join('/')
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
