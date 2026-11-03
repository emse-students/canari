import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { avatarUrl, setAvatarToken } from './avatarUrl';

/**
 * ONE BUILDER OF A USER'S AVATAR URL (docs/wiki/sessions.md, "The avatar token").
 *
 * The URL carries the viewer's avatar token, and a builder that spells `/api/users/<id>/avatar` by
 * hand sends none: in phase 1 the server still answers it and counts it as `[AVATAR_UNSIGNED]`, and
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

  it('carries the avatar token as ?t= while the session holds one', () => {
    setAvatarToken('0f8fad5b-d9cb-469f-a165-70867728950e.mac_-');
    expect(avatarUrl('u 1')).toMatch(
      /\/api\/users\/u%201\/avatar\?t=0f8fad5b-d9cb-469f-a165-70867728950e\.mac_-$/
    );
  });

  it('is unsigned with no token (signed out, or a server that minted none)', () => {
    expect(avatarUrl('u1')).toMatch(/\/api\/users\/u1\/avatar$/);
    setAvatarToken('');
    expect(avatarUrl('u1')).not.toContain('?t=');
  });

  it('forgets the token when the session ends', () => {
    setAvatarToken('sid.mac');
    setAvatarToken(null);
    expect(avatarUrl('u1')).not.toContain('?t=');
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
