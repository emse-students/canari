import { readFileSync } from 'node:fs';
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

/** Every permission identifier granted by any capability file, verbatim. */
function grantedIdentifiers(): Set<string> {
  const identifiers = new Set<string>();
  for (const file of ['default.json', 'development.json']) {
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

  it('never lets the cold-start deep-link probe swallow its own failure', () => {
    // The permission gap cost a day precisely because `.catch(() => {})` made a rejected invoke
    // and "this launch carried no URL" the same observation. A silent catch here would hide the
    // next ACL gap exactly as well as it hid this one.
    const hooks = readFileSync(resolve(here, '../../hooks.client.ts'), 'utf8');
    expect(hooks).toContain('getCurrent() failed');
  });
});
