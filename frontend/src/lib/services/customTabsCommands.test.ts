import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CUSTOM_TABS_COMMAND_NAMES,
  CUSTOM_TABS_PLUGIN,
  customTabsCommand,
} from './customTabsCommands';

/**
 * Cross-language contract guard, same shape as `keystoreCommands.test.ts`: a
 * `plugin:<name>|<command>` string compiles, lints and type-checks while resolving to nothing at
 * runtime if either side drifts. These tests read the Rust sources so a rename fails CI instead
 * of silently disabling the Custom Tab (falling back to nothing - `openUrl` is not a fallback,
 * see `auth.ts`).
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PLUGIN_DIR = '../../../src-tauri/plugins/tauri-plugin-customtabs/';
const libRs = read(`${PLUGIN_DIR}src/lib.rs`);
const buildRs = read(`${PLUGIN_DIR}build.rs`);
const commandsRs = read(`${PLUGIN_DIR}src/commands.rs`);

const jsCommands = Object.values(CUSTOM_TABS_COMMAND_NAMES);

describe('customTabsCommand', () => {
  it('builds a fully-qualified identifier', () => {
    expect(customTabsCommand('openCustomTab')).toBe('plugin:customtabs|open_custom_tab');
  });

  it('uses the Tauri plugin name, not the Android class identifier', () => {
    // The exact regression keystoreCommands.test.ts pins for its own plugin:
    // "app.tauri.customtabs" is what register_android_plugin() takes, and using it as the
    // invoke prefix resolves no plugin at all.
    const registered = libRs.match(/Builder::new\("([^"]+)"\)/)?.[1];
    expect(registered).toBe(CUSTOM_TABS_PLUGIN);
    expect(customTabsCommand('openCustomTab')).not.toContain('app.tauri.customtabs');
  });
});

describe('customtabs command contract', () => {
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
    const acl = [...buildRs.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    for (const cmd of jsCommands) expect(acl).toContain(cmd);
  });

  it('grants every JS-invoked command in the default permission set', () => {
    const defaultToml = read(`${PLUGIN_DIR}permissions/default.toml`);
    for (const cmd of jsCommands) {
      expect(defaultToml).toContain(`allow-${cmd.replace(/_/g, '-')}`);
    }
  });
});
