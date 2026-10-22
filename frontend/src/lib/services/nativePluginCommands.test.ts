import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CUSTOM_TABS_COMMAND_NAMES,
  CUSTOM_TABS_PLUGIN,
  customTabsCommand,
} from './customTabsCommands';
import { KEYSTORE_COMMAND_NAMES, KEYSTORE_PLUGIN, keystoreCommand } from './keystoreCommands';

/**
 * Cross-language contract guard for the two hand-written Tauri plugins whose command names are
 * built in TypeScript (keystore, customtabs). A `plugin:<name>|<command>` string is unchecked on
 * both sides: it compiles, lints and type-checks while resolving to nothing at runtime if either
 * side drifts. These tests read the Rust sources so a rename fails CI instead of silently
 * disabling biometrics or the Custom Tab (`openUrl` is not a fallback, see `auth.ts`).
 *
 * One `describe.each` row per plugin: the six cases are the same rule, so adding a plugin is a row,
 * not a copied file. (`galleryCommands.test.ts` has a different shape and stays apart.)
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

interface PluginRow {
  label: string;
  pluginDir: string;
  /** The Tauri plugin name, which is the invoke prefix. */
  plugin: string;
  /** The Android class identifier register_android_plugin() takes - NOT an invoke prefix. */
  androidId: string;
  commandNames: Record<string, string>;
  /** Builds `plugin:<name>|<command>`; typed loosely so one table serves both plugins. */
  build: (name: never) => string;
  /** A command and its expected identifier. */
  sample: [string, string];
  /** The command used for the "not the Android class identifier" case. */
  otherSample: string;
}

const ROWS: PluginRow[] = [
  {
    label: 'keystore',
    pluginDir: '../../../src-tauri/patches/tauri-plugin-keystore/',
    plugin: KEYSTORE_PLUGIN,
    androidId: 'app.tauri.keystore',
    commandNames: KEYSTORE_COMMAND_NAMES,
    build: keystoreCommand,
    sample: ['hasKeyBytes', 'plugin:keystore|has_key_bytes'],
    otherSample: 'getKeyBytes',
  },
  {
    label: 'customtabs',
    pluginDir: '../../../src-tauri/plugins/tauri-plugin-customtabs/',
    plugin: CUSTOM_TABS_PLUGIN,
    androidId: 'app.tauri.customtabs',
    commandNames: CUSTOM_TABS_COMMAND_NAMES,
    build: customTabsCommand,
    sample: ['openCustomTab', 'plugin:customtabs|open_custom_tab'],
    otherSample: 'openCustomTab',
  },
];

describe.each(ROWS)('$label plugin command contract', (row) => {
  const libRs = read(`${row.pluginDir}src/lib.rs`);
  const buildRs = read(`${row.pluginDir}build.rs`);
  const commandsRs = read(`${row.pluginDir}src/commands.rs`);
  const jsCommands = Object.values(row.commandNames);
  const build = row.build as (name: string) => string;

  it('builds a fully-qualified identifier', () => {
    expect(build(row.sample[0])).toBe(row.sample[1]);
  });

  it('uses the Tauri plugin name, not the Android class identifier', () => {
    // The exact regression: the Android id is what register_android_plugin() takes, and using it
    // as the invoke prefix resolves no plugin at all.
    const registered = libRs.match(/Builder::new\("([^"]+)"\)/)?.[1];
    expect(registered).toBe(row.plugin);
    expect(build(row.otherSample)).not.toContain(row.androidId);
  });

  it('declares every JS-invoked command in generate_handler!', () => {
    const registered = [...libRs.matchAll(/commands::(\w+)/g)].map((m) => m[1]);
    for (const cmd of jsCommands) expect(registered).toContain(cmd);
  });

  it('defines every JS-invoked command as a #[command] fn', () => {
    for (const cmd of jsCommands) {
      expect(commandsRs).toMatch(new RegExp(`fn ${cmd}\\b`));
    }
  });

  it('lists every JS-invoked command in the build.rs ACL array', () => {
    // Missing here means the IPC boundary refuses the call even though the Rust fn exists.
    const acl = [...buildRs.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    for (const cmd of jsCommands) expect(acl).toContain(cmd);
  });

  it('grants every JS-invoked command in the default permission set', () => {
    const defaultToml = read(`${row.pluginDir}permissions/default.toml`);
    for (const cmd of jsCommands) {
      expect(defaultToml).toContain(`allow-${cmd.replace(/_/g, '-')}`);
    }
  });
});

/**
 * THE WEBVIEW CANNOT WRITE OR DELETE A KEYSTORE ENTRY (2026-10-22): on a phone the entry is the only
 * copy of the hardware-held at-rest key, and every mutation must go through the at-rest guard in the
 * app's Rust bridge. A grant here would be a path around that guard.
 */
describe('keystore mutations stay behind the at-rest guard', () => {
  const pluginDir = '../../../src-tauri/patches/tauri-plugin-keystore/';

  it('grants the plugin no store and no delete in its default set', () => {
    const permissions = read(`${pluginDir}permissions/default.toml`)
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(permissions).not.toMatch(/allow-store|allow-delete/);
  });

  // The app windows' side - every capability file, not only `default.json` - is held in
  // `tauriCapabilities.test.ts`, which already reads the whole directory.
});
