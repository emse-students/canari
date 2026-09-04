import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tauri capability guardrail - every plugin the app depends on must be GRANTED.
 *
 * Tauri v2 gates plugin COMMANDS behind an ACL: a command whose permission is absent from the
 * capability files rejects at runtime, on the device, with `<plugin>.<command> not allowed`. Nothing
 * type-checks it, nothing fails to build, and the CI never sees it - the dependency compiles and the
 * plugin loads regardless.
 *
 * That is not hypothetical. `deep-link` was in `Cargo.toml`, configured in `tauri.conf.json` with
 * five schemes, and used by `hooks.client.ts` - but had NO entry in `capabilities/default.json`, so
 * `getCurrent()` rejected on every call. Deep links still worked whenever the app was already
 * running, because `onOpenUrl` is an event channel the Rust side registers and events are not
 * ACL-gated; only the COLD START path goes through `getCurrent`. So tapping a notification while the
 * app was closed opened Canari on the default route and left it there (WP-DEEPLINK-1), on both
 * platforms, for as long as the permission was missing.
 *
 * This test is the cheap half of that lesson: a plugin added to `Cargo.toml` and not to a capability
 * file is a build that ships a dead command.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC_TAURI = resolve(here, '../../../src-tauri');

/**
 * Plugins with no JS-facing command surface, which therefore need no grant.
 *
 * `localhost` only serves the built assets over an http origin from Rust; it exposes nothing to the
 * WebView. Anything added here needs that same justification in writing - an exemption is how this
 * test stops catching the bug it exists for.
 */
const NO_JS_COMMANDS = new Set(['localhost']);

/** Plugin short names, as they appear in a permission identifier (`deep-link:default`). */
function pluginsFromCargo(): string[] {
  const cargo = readFileSync(resolve(SRC_TAURI, 'Cargo.toml'), 'utf8');
  const names = new Set<string>();
  for (const line of cargo.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue; // commented-out deps, and the patch rationale
    const m = trimmed.match(/^tauri-plugin-([a-z0-9-]+)\s*=/);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

/** Every capability file on disk, read rather than listed. */
function capabilityFiles(): string[] {
  // READ THE DIRECTORY, NEVER A HARD-CODED PAIR. This named `default.json` and `development.json`,
  // so renaming the second to `local-estate.json` on 2026-09-04 did not make the test say something
  // useful - it made it throw ENOENT, three tests down, about a file whose absence was the intended
  // change. A list of filenames is a second copy of what the directory already knows.
  return readdirSync(resolve(SRC_TAURI, 'capabilities'))
    .filter((f) => f.endsWith('.json'))
    .sort();
}

/** One capability file, parsed. */
function capability(file: string): {
  identifier: string;
  permissions: (string | { identifier: string; allow?: { url: string }[] })[];
} {
  return JSON.parse(readFileSync(resolve(SRC_TAURI, 'capabilities', file), 'utf8'));
}

/** Every permission identifier granted by any capability file, verbatim. */
function grantedIdentifiers(): Set<string> {
  const identifiers = new Set<string>();
  for (const file of capabilityFiles()) {
    const capability = JSON.parse(readFileSync(resolve(SRC_TAURI, 'capabilities', file), 'utf8'));
    for (const permission of capability.permissions as (string | { identifier: string })[]) {
      identifiers.add(typeof permission === 'string' ? permission : permission.identifier);
    }
  }
  return identifiers;
}

/** Every permission identifier granted by any capability file, plugin prefix only. */
function grantedPrefixes(): Set<string> {
  const prefixes = new Set<string>();
  for (const identifier of grantedIdentifiers()) {
    const [prefix] = identifier.split(':');
    if (prefix) prefixes.add(prefix);
  }
  return prefixes;
}

describe('Tauri capabilities', () => {
  it('grants a permission to every plugin that exposes commands to the WebView', () => {
    const granted = grantedPrefixes();
    const ungranted = pluginsFromCargo().filter(
      (name) => !NO_JS_COMMANDS.has(name) && !granted.has(name)
    );
    expect(ungranted).toEqual([]);
  });

  it('grants deep-link, without which a cold-start notification tap loses its target', () => {
    // Pinned by name rather than by prefix: `deep-link:default` IS `allow-get-current`, and
    // `get_current` is the only command a cold start can use.
    const granted = grantedPrefixes();
    expect(granted.has('deep-link')).toBe(true);
  });

  it('grants the commands that saving an attachment to disk goes through', () => {
    // A GRANTED PREFIX IS NOT A GRANTED COMMAND. `fs:default` is read-only - it allows reading
    // the app-specific directories and creating them, nothing else - so `fs` appearing in the
    // capability file says nothing about whether a write is allowed. Saving a decrypted
    // attachment is the only write path the WebView has, and it is the only download path that
    // works at all on a phone (Tauri installs no WebView download handler, so `<a download>`
    // resolves to nothing). Without these three the button fails on the device, not in CI.
    const granted = grantedIdentifiers();
    for (const identifier of ['fs:allow-write-file', 'fs:allow-create', 'fs:allow-write']) {
      expect(granted.has(identifier)).toBe(true);
    }
    // `dialog:default` is `allow-save` + `allow-open` + `allow-message`; the save picker is
    // what puts the chosen destination into the fs scope.
    expect(granted.has('dialog:default')).toBe(true);
  });

  // ---------------------------------------------------------------------------------------------
  // WHAT A RELEASE BUILD MAY REACH. Added 2026-09-04, after a capability whose own description said
  // "NOT included in production builds" turned out to be in all of them.
  // ---------------------------------------------------------------------------------------------

  it('names its capabilities explicitly, because an empty list silently means ALL of them', () => {
    const conf = JSON.parse(readFileSync(resolve(SRC_TAURI, 'tauri.conf.json'), 'utf8'));
    const named: string[] = conf.app?.security?.capabilities ?? [];
    // An ABSENT or empty list is how `development.json` shipped: Tauri documents it as including
    // every file in `capabilities/`. The subset must be spelt or there is no subset.
    expect(named.length).toBeGreaterThan(0);

    const identifiers = capabilityFiles().map((f) => capability(f).identifier);
    for (const name of named) {
      // A typo here does not fail the build - it silently drops a capability the app needs.
      expect(identifiers).toContain(name);
    }
  });

  it('grants no plaintext or localhost scope in anything a release build compiles', () => {
    const conf = JSON.parse(readFileSync(resolve(SRC_TAURI, 'tauri.conf.json'), 'utf8'));
    const named: string[] = conf.app?.security?.capabilities ?? [];

    for (const file of capabilityFiles()) {
      const cap = capability(file);
      if (!named.includes(cap.identifier)) continue; // opt-in, added by a debug-only --config overlay
      for (const permission of cap.permissions) {
        if (typeof permission === 'string') continue;
        for (const entry of permission.allow ?? []) {
          // THE ESTATE IS NOT REACHED IN PLAINTEXT FROM A SHIPPED APP. `http://**` and
          // `ws://localhost:*` rode into production for months on a description that claimed
          // otherwise, and a description is not a mechanism.
          expect(entry.url.startsWith('https://') || entry.url.startsWith('wss://')).toBe(true);
        }
      }
    }
  });

  it('keeps the local-estate scope opt-in, and spells the port wildcard it needs', () => {
    const conf = JSON.parse(readFileSync(resolve(SRC_TAURI, 'tauri.conf.json'), 'utf8'));
    const named: string[] = conf.app?.security?.capabilities ?? [];
    const local = capabilityFiles()
      .map((f) => capability(f))
      .find((c) => c.identifier === 'local-estate');
    expect(local).toBeDefined();

    // It must NOT be in the base config - only the debug overlay may add it.
    expect(named).not.toContain('local-estate');

    const overlay = JSON.parse(readFileSync(resolve(SRC_TAURI, 'tauri.local.conf.json'), 'utf8'));
    expect(overlay.app.security.capabilities).toContain('local-estate');

    // AN EMPTY PORT MEANS THE PROTOCOL'S DEFAULT PORT, so `http://**` matches port 80 and nothing
    // else - which is why the estate on :8081 was refused while `https://**` appeared to work. Every
    // entry here must therefore carry an explicit port wildcard.
    for (const permission of local!.permissions) {
      if (typeof permission === 'string') continue;
      for (const entry of permission.allow ?? []) {
        expect(entry.url).toMatch(/:\*$/);
      }
    }
  });

  it('never lets the cold-start deep-link probe swallow its own failure', () => {
    // The permission gap cost a day precisely because `.catch(() => {})` made a rejected invoke
    // and "this launch carried no URL" the same observation. A silent catch here would hide the
    // next ACL gap exactly as well as it hid this one.
    const hooks = readFileSync(resolve(here, '../../hooks.client.ts'), 'utf8');
    expect(hooks).toContain('getCurrent() failed');
  });
});
