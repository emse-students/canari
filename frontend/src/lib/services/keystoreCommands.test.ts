import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KEYSTORE_COMMAND_NAMES, KEYSTORE_PLUGIN, keystoreCommand } from './keystoreCommands';

/**
 * Cross-language contract guard. A `plugin:<name>|<command>` string is unchecked on both sides:
 * it compiles, lints and type-checks while resolving to nothing at runtime. These tests read the
 * Rust sources so a rename on either side fails CI instead of silently disabling biometrics.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PLUGIN_DIR = '../../../src-tauri/patches/tauri-plugin-keystore/';
const libRs = read(`${PLUGIN_DIR}src/lib.rs`);
const buildRs = read(`${PLUGIN_DIR}build.rs`);
const commandsRs = read(`${PLUGIN_DIR}src/commands.rs`);

const jsCommands = Object.values(KEYSTORE_COMMAND_NAMES);

describe('keystoreCommand', () => {
  it('builds a fully-qualified identifier', () => {
    expect(keystoreCommand('hasKeyBytes')).toBe('plugin:keystore|has_key_bytes');
  });

  it('uses the Tauri plugin name, not the Android class identifier', () => {
    // The exact regression: "app.tauri.keystore" is what register_android_plugin() takes, and
    // using it as the invoke prefix resolves no plugin at all.
    const registered = libRs.match(/Builder::new\("([^"]+)"\)/)?.[1];
    expect(registered).toBe(KEYSTORE_PLUGIN);
    expect(keystoreCommand('getKeyBytes')).not.toContain('app.tauri.keystore');
  });
});

describe('keystore command contract', () => {
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
    const defaultToml = read(`${PLUGIN_DIR}permissions/default.toml`);
    for (const cmd of jsCommands) {
      expect(defaultToml).toContain(`allow-${cmd.replace(/_/g, '-')}`);
    }
  });
});
