import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { avatarUrl, setAvatarToken } from './avatarUrl';

/**
 * ONE BUILDER OF A USER'S AVATAR URL (docs/wiki/sessions.md, "The avatar token").
 *
 * The URL carries the viewer's avatar token, and a builder that spells `/api/users/<id>/avatar` by
 * hand sends none: in phase 1 the server still answers it and logs it `access=unsigned`, and
 * in phase 2 it is refused - a face drawn as initials, with nothing in the client saying why. Three
 * such builders existed (`Avatar.svelte`, `PosterCanvas.svelte`, `trombinoscope.ts`); this file
 * fails if a fourth appears anywhere in `src/`.
 */

/** The shapes a hand-built avatar URL takes: a template with the id in it, or a concatenation. */
const RAW_BUILDERS = [
  /\/api\/users\/\$\{[^}]*\}\/avatar/,
  /users\/['"`]\s*\+[^\n;]*\+\s*['"`]\/avatar/,
];

/** The one file allowed to spell the route: the helper itself. */
const HELPER = ['src', 'lib', 'utils', 'avatarUrl.ts'].join(sep);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Generated code (the WASM binding, paraglide) builds no avatar URL and is not ours to edit.
      if (entry.name === 'wasm' || entry.name === 'paraglide') return [];
      return sourceFiles(path);
    }
    if (!/\.(ts|js|svelte)$/.test(entry.name)) return [];
    // A test may spell a URL to assert against; it builds nothing that reaches a server.
    if (/\.(test|spec)\.ts$/.test(entry.name)) return [];
    return [path];
  });
}

describe('avatarUrl', () => {
  afterEach(() => setAvatarToken(null));

  const DAY = 86_400_000;
  /** Noon, UTC, on day 20000: every instant below is passed in, never read from the wall clock. */
  const NOON = 20_000 * DAY + DAY / 2;
  const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('carries the avatar token as ?t= while the session holds one', () => {
    setAvatarToken(`${SID}.20000.mac_-`);
    expect(avatarUrl('u 1', NOON)).toMatch(
      /\/api\/users\/u%201\/avatar\?t=0f8fad5b-d9cb-469f-a165-70867728950e\.20000\.mac_-$/
    );
  });

  it("still sends yesterday's token - the server honours it - but not one older", () => {
    setAvatarToken(`${SID}.20000.mac`);
    expect(avatarUrl('u1', NOON + DAY)).toContain('?t=');
    // Two days on and not refreshed: a token the server would refuse is not sent, the request goes
    // unsigned (answered in phase 1) instead of earning a 403 and a face drawn as initials.
    expect(avatarUrl('u1', NOON + 2 * DAY)).toMatch(/\/api\/users\/u1\/avatar$/);
    // ...until the next refresh adopts a token of today.
    setAvatarToken(`${SID}.20002.mac`);
    expect(avatarUrl('u1', NOON + 2 * DAY)).toContain('?t=');
  });

  it('a token whose day cannot be read is not sent', () => {
    setAvatarToken(`${SID}.mac`);
    expect(avatarUrl('u1', NOON)).not.toContain('?t=');
    setAvatarToken(`${SID}.020000.mac`);
    expect(avatarUrl('u1', NOON)).not.toContain('?t=');
  });

  it('is unsigned with no token (signed out, or a server that minted none)', () => {
    expect(avatarUrl('u1', NOON)).toMatch(/\/api\/users\/u1\/avatar$/);
    setAvatarToken('');
    expect(avatarUrl('u1', NOON)).not.toContain('?t=');
  });

  it('forgets the token when the session ends', () => {
    setAvatarToken(`${SID}.20000.mac`);
    setAvatarToken(null);
    expect(avatarUrl('u1', NOON)).not.toContain('?t=');
  });
});

describe('no hand-built avatar URL anywhere in src/', () => {
  it('CONTROL: the guard recognises the builders it replaced', () => {
    const replaced = [
      'const avatarSrc = $derived(`${coreUrl()}/api/users/${encodeURIComponent(userId)}/avatar`);',
      'src={apiAssetUrl(`/api/users/${encodeURIComponent(person.userId)}/avatar`)}',
      "const u = base + '/api/users/' + id + '/avatar';",
    ];
    for (const line of replaced) {
      expect(RAW_BUILDERS.some((re) => re.test(line))).toBe(true);
    }
    // ...and leaves a comment naming the route alone.
    expect(RAW_BUILDERS.some((re) => re.test('// GET /api/users/<id>/avatar'))).toBe(false);
  });

  it('every avatar URL in src/ goes through avatarUrl(userId)', () => {
    const root = process.cwd();
    const files = sourceFiles(join(root, 'src'));
    // A walk that found nothing would pass vacuously.
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((file) => relative(root, file) !== HELPER)
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${relative(root, file)}:${i + 1}` }))
          .filter(({ line }) => RAW_BUILDERS.some((re) => re.test(line)))
          .map(({ at }) => at)
      );
    expect(offenders).toEqual([]);
    // A walk of the whole tree: measured ~6 s on a Windows workstation, past vitest's 5 s default.
  }, 60_000);
});
