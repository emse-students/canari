import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RESTORE_COMMAND_NAMES, RESTORE_PLUGIN, restoreCommand } from './restoreCommands';

/**
 * Cross-language contract guard, same shape as `customTabsCommands.test.ts`: a
 * `plugin:<name>|<command>` string compiles, lints and type-checks while resolving to nothing at
 * runtime if either side drifts. These tests read the Rust and Kotlin sources so a rename fails CI
 * instead of silently disabling account restore.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PLUGIN_DIR = '../../../src-tauri/plugins/tauri-plugin-restore/';
const libRs = read(`${PLUGIN_DIR}src/lib.rs`);
const buildRs = read(`${PLUGIN_DIR}build.rs`);
const commandsRs = read(`${PLUGIN_DIR}src/commands.rs`);
const mobileRs = read(`${PLUGIN_DIR}src/mobile.rs`);
const kotlin = read(`${PLUGIN_DIR}android/src/main/java/RestorePlugin.kt`);

const jsCommands = Object.values(RESTORE_COMMAND_NAMES);

describe('restoreCommand', () => {
  it('builds a fully-qualified identifier', () => {
    expect(restoreCommand('get')).toBe('plugin:restore|get_restore_credential');
  });

  it('uses the Tauri plugin name, not the Android class identifier', () => {
    const registered = libRs.match(/Builder::new\("([^"]+)"\)/)?.[1];
    expect(registered).toBe(RESTORE_PLUGIN);
  });
});

describe('restore command contract', () => {
  it('declares every JS-invoked command in generate_handler!', () => {
    const registered = [...libRs.matchAll(/commands::(\w+)/g)].map((m) => m[1]);
    for (const cmd of jsCommands) expect(registered).toContain(cmd);
  });

  it('defines every JS-invoked command as a #[command] fn', () => {
    for (const cmd of jsCommands) expect(commandsRs).toMatch(new RegExp(`fn ${cmd}\\b`));
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

  it('names a Kotlin @Command for every method the Rust side runs', () => {
    const methods = [...mobileRs.matchAll(/run_mobile_plugin\(\s*"(\w+)"/g)].map((m) => m[1]);
    expect(methods).toHaveLength(3);
    for (const method of methods) {
      expect(kotlin).toMatch(new RegExp(`@Command\\s+fun ${method}\\(`));
    }
  });

  it('reads the argument name the Kotlin side parses', () => {
    // `RequestPayload { request_json }` serialises camelCase; Kotlin's `RequestArgs` must match.
    expect(mobileRs).toContain('rename_all = "camelCase"');
    expect(kotlin).toContain('lateinit var requestJson: String');
  });
});
