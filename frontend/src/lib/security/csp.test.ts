/**
 * The Content-Security-Policy served to this app, asserted against what the app actually does.
 *
 * It lives in the frontend suite rather than next to the Dockerfile because the thing that can
 * invalidate it is FRONTEND code: the policy is a description of which hosts the client reads
 * from, and it goes stale the moment a component calls a host nobody added to `connect-src`.
 * That failure is invisible in every gate we run - it compiles, it lints, it deploys, and only a
 * browser on the real origin refuses the request. Commenting a GIF was broken that way: the
 * picker's grid rendered (wide `img-src`) while fetching the chosen GIF's bytes was blocked
 * (narrow `connect-src`), so the feature looked alive and did nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Resolved from the vitest root (`frontend/`) rather than from `import.meta.url`, which vite
// serves as a non-file URL.
const DOCKERFILE = resolve(process.cwd(), '../infrastructure/local/Dockerfile.frontend');

const dockerfile = readFileSync(DOCKERFILE, 'utf8');

/** Every `add_header Content-Security-Policy "..."` in the Dockerfile, shell-unescaped. */
function policyDeclarations(): string[] {
  return [...dockerfile.matchAll(/add_header Content-Security-Policy "(.*?)" always;/g)].map((m) =>
    // The Dockerfile writes the config from a single-quoted shell string, so every literal
    // quote inside it is spelled `'"'"'`. Undo that to read the policy as the browser sees it.
    m[1].replaceAll(`'"'"'`, `'`)
  );
}

/** The value of one directive, as the list of sources it allows. */
function sources(policy: string, directive: string): string[] {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === directive || part.startsWith(`${directive} `));
  expect(found, `policy has no ${directive} directive`).toBeDefined();
  return found!.split(/\s+/).slice(1);
}

describe('the served Content-Security-Policy', () => {
  it('is declared exactly once, and included wherever it is needed', () => {
    // nginx's add_header REPLACES the inherited set, so three blocks each need the policy. Three
    // verbatim copies is how one of them silently keeps an old value: this asserts there is one
    // definition and that the blocks reach it by include, never by restating it.
    expect(policyDeclarations()).toHaveLength(1);
    expect(dockerfile.match(/include \/etc\/nginx\/snippets\/csp\.conf;/g)?.length).toBeGreaterThan(
      1
    );
  });

  it('names every external host the client reads bytes from', () => {
    const connect = sources(policyDeclarations()[0], 'connect-src');
    // GifPickerModal searches this host...
    expect(connect).toContain('https://api.klipy.com');
    // ...and PostComments fetches the chosen GIF's BYTES from this one, to encrypt them before
    // upload. Rendering the grid is `img-src`; reading bytes into memory is `connect-src`, and
    // only the second one is what attaching a GIF to a comment needs.
    expect(connect).toContain('https://static.klipy.com');
  });

  it('never widens connect-src to a bare scheme', () => {
    // `img-src` is deliberately `https:`, because it renders arbitrary user-posted image URLs.
    // `connect-src` governs what the app may read into memory and must stay an allowlist - a
    // future host that is blocked is fixed by naming it here, never by opening the directive.
    const connect = sources(policyDeclarations()[0], 'connect-src');
    expect(connect).not.toContain('https:');
    expect(connect).not.toContain('*');
  });
});
