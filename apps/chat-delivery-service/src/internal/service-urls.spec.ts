/// <reference types="jest" />

import { readdirSync, readFileSync, statSync } from 'fs';
import { join as joinPath, resolve, sep } from 'path';
import { coreUrl, mediaUrl } from './service-urls';

/**
 * THE LAST TEST IS THE ONE THAT MATTERS: a production source that names an internal service's base
 * URL fails the suite. It is what turns "remember the prefix" into something the repository checks
 * rather than something a reviewer has to - and a reviewer did not, four times, in social-service.
 *
 * The three call sites this seam replaced here were all CORRECT. The guard is not defending a
 * defect, it is defending the absence of one against the next call site.
 */
const SRC = resolve(__dirname, '..');

/** Every internal base this service names - not the ones some past defect happened to involve. */
const INTERNAL_BASES = ['MEDIA_SERVICE_URL', 'CORE_SERVICE_INTERNAL_URL'];

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
    expect(mediaUrl('media/internal/abc')).toBe('http://media-service:3011/api/media/internal/abc');
  });

  it('addresses core-service the same way', () => {
    delete process.env.CORE_SERVICE_INTERNAL_URL;
    expect(coreUrl('users/abc/avatar')).toBe('http://core-service:3012/api/users/abc/avatar');
  });

  it('does not double the prefix when an operator has already appended it', () => {
    process.env.MEDIA_SERVICE_URL = 'http://media-service:3011/api';
    expect(mediaUrl('media/internal/abc')).toBe('http://media-service:3011/api/media/internal/abc');
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
