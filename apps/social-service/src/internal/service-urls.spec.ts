/// <reference types="jest" />

import { readdirSync, readFileSync, statSync } from 'fs';
import { join as joinPath, resolve, sep } from 'path';
import { deliveryUrl, mediaUrl } from './service-urls';

/**
 * FOUR CALLERS IN THIS SERVICE HAVE NOW ADDRESSED ANOTHER SERVICE WITHOUT ITS `/api` PREFIX, and
 * every one of them failed silently - see this module's own docblock for the four and what each
 * cost. Three were fixed by routing them here; the fourth was fixed by noticing that media-service
 * had never been offered at all.
 *
 * So the last test is the one that matters: a production source that names an internal service's
 * base URL fails the suite. It is what turns "remember the prefix" into something the repository
 * checks rather than something a reviewer has to.
 */
const SRC = resolve(__dirname, '..');

/** Base URLs whose prefix is this module's to write, and no caller's. */
const INTERNAL_BASES = ['MEDIA_SERVICE_URL', 'DELIVERY_INTERNAL_URL'];

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
    process.env.MEDIA_SERVICE_URL = saved.MEDIA_SERVICE_URL;
    process.env.DELIVERY_INTERNAL_URL = saved.DELIVERY_INTERNAL_URL;
    if (saved.MEDIA_SERVICE_URL === undefined) delete process.env.MEDIA_SERVICE_URL;
    if (saved.DELIVERY_INTERNAL_URL === undefined) delete process.env.DELIVERY_INTERNAL_URL;
  });

  it('inserts the global prefix the environment variable does not carry', () => {
    delete process.env.MEDIA_SERVICE_URL;
    expect(mediaUrl('media/internal/abc')).toBe('http://media-service:3011/api/media/internal/abc');
  });

  it('addresses chat-delivery-service the same way', () => {
    delete process.env.DELIVERY_INTERNAL_URL;
    expect(deliveryUrl('internal/push/notify')).toBe(
      'http://chat-delivery-service:3010/api/internal/push/notify'
    );
  });

  it('does not double the prefix when an operator has already appended it', () => {
    process.env.MEDIA_SERVICE_URL = 'http://media-service:3011/api';
    expect(mediaUrl('media/upload/public')).toBe(
      'http://media-service:3011/api/media/upload/public'
    );
  });

  it('tolerates a trailing slash on the base and a leading one on the path', () => {
    process.env.MEDIA_SERVICE_URL = 'http://media-service:3011///';
    expect(mediaUrl('///media/abc')).toBe('http://media-service:3011/api/media/abc');
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
