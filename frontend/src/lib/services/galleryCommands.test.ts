import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GALLERY_COMMAND_NAMES,
  GALLERY_NAME_HEADER,
  GALLERY_PLUGIN,
  galleryCommand,
} from './galleryCommands';

/**
 * Cross-language contract guard, the same shape as `customTabsCommands.test.ts`: a
 * `plugin:<name>|<command>` string compiles while resolving to nothing at runtime if either side
 * drifts, so these tests read the Rust sources and the app's capability file.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PLUGIN_DIR = '../../../src-tauri/plugins/tauri-plugin-gallery/';
const libRs = read(`${PLUGIN_DIR}src/lib.rs`);
const buildRs = read(`${PLUGIN_DIR}build.rs`);
const commandsRs = read(`${PLUGIN_DIR}src/commands.rs`);
const defaultToml = read(`${PLUGIN_DIR}permissions/default.toml`);
const capabilities = read('../../../src-tauri/capabilities/default.json');
const appLibRs = read('../../../src-tauri/src/lib.rs');

const jsCommands = Object.values(GALLERY_COMMAND_NAMES);

describe('galleryCommand', () => {
  it('builds fully-qualified identifiers on the Tauri plugin name', () => {
    expect(galleryCommand('saveVideo')).toBe('plugin:gallery|save_video');
    expect(libRs.match(/Builder::new\("([^"]+)"\)/)?.[1]).toBe(GALLERY_PLUGIN);
  });
});

describe('gallery command contract', () => {
  it('declares, defines, lists and grants every JS-invoked command', () => {
    const registered = [...libRs.matchAll(/commands::(\w+)/g)].map((m) => m[1]);
    const acl = [...buildRs.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    for (const cmd of jsCommands) {
      expect(registered).toContain(cmd);
      expect(commandsRs).toMatch(new RegExp(`fn ${cmd}\\b`));
      expect(acl).toContain(cmd);
      expect(defaultToml).toContain(`allow-${cmd.replace(/_/g, '-')}`);
    }
  });

  it('reads the file name from the header the client sends', () => {
    expect(commandsRs).toContain(`"${GALLERY_NAME_HEADER}"`);
  });

  it('is granted to the app and registered on mobile', () => {
    expect(capabilities).toContain('"gallery:default"');
    expect(appLibRs).toContain('tauri_plugin_gallery::init()');
  });
});
