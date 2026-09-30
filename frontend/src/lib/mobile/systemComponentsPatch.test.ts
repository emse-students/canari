import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE VENDORED PLUGIN'S TWO HALVES MUST AGREE ON EVERY FIELD (`src-tauri/patches/
 * tauri-plugin-system-components`).
 *
 * A plugin command reaches Swift THROUGH the Rust struct: Tauri runs the Rust command first, which
 * deserialises the arguments into `src/models.rs` and serialises them again for Swift. So a field
 * the Swift `Decodable` reads and the Rust struct lacks is dropped on the way, silently - which is
 * how the tab bar's `selectedImage` patch shipped in Swift alone and never drew the yellow. Nothing
 * but an iPhone would have shown it; this reads both files and compares them.
 */

/** Relative to `frontend/`, where the suite runs - as `appIcons.test.ts` reads `src/app.html`. */
const PLUGIN = 'src-tauri/patches/tauri-plugin-system-components/';
const read = (path: string) => readFileSync(PLUGIN + path, 'utf8');

/** Every Swift argument class, and the Rust struct its JSON crosses first. */
const PAIRS: Record<string, string> = {
  TabItemArgs: 'TabItem',
  AccessoryArgs: 'AccessoryItem',
  ConfigureTabBarArgs: 'ConfigureTabBarOptions',
  SelectTabArgs: 'SelectTabOptions',
  SetBadgeArgs: 'SetBadgeOptions',
  SheetOptionArgs: 'SheetOption',
  SheetRowArgs: 'SheetRow',
  PresentSheetArgs: 'PresentSheetOptions',
  DismissSheetArgs: 'DismissSheetOptions',
  ComponentPropsArgs: 'ComponentProps',
  CreateComponentArgs: 'CreateComponentOptions',
  UpdateComponentArgs: 'UpdateComponentOptions',
  UpdateComponentsArgs: 'UpdateComponentsOptions',
  RemoveComponentArgs: 'RemoveComponentOptions',
};

/** The body of a top-level declaration: from its opening line to the first `}` in column 0. */
function body(source: string, opening: RegExp): string {
  const start = source.search(opening);
  if (start < 0) return '';
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

/** The `let` fields of every Swift `Decodable` class in the plugin's sources. */
function swiftFields(): Record<string, string[]> {
  const source = [
    'ios/Sources/SystemComponentsPlugin.swift',
    'ios/Sources/Components/ComponentArgs.swift',
  ]
    .map(read)
    .join('\n');
  const fields: Record<string, string[]> = {};
  for (const [, name] of source.matchAll(/^class (\w+): Decodable \{/gm)) {
    const block = body(source, new RegExp(`^class ${name}: Decodable \\{`, 'm'));
    fields[name] = [...block.matchAll(/^\s+let (\w+):/gm)].map(([, field]) => field);
  }
  return fields;
}

/** The fields of a Rust struct in `models.rs`, in the camelCase its `rename_all` sends. */
function rustFields(models: string, name: string): string[] {
  const block = body(models, new RegExp(`^pub struct ${name} \\{`, 'm'));
  return [...block.matchAll(/^\s+pub (\w+):/gm)].map(([, field]) =>
    field.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())
  );
}

describe('the vendored system-components plugin', () => {
  const swift = swiftFields();
  const models = read('src/models.rs');

  it('pairs every Swift argument class with a Rust struct', () => {
    expect(Object.keys(swift).sort()).toEqual(Object.keys(PAIRS).sort());
  });

  it.each(Object.entries(PAIRS))('%s: every field Swift reads crosses %s', (swiftName, rust) => {
    const carried = rustFields(models, rust);
    expect(carried.length).toBeGreaterThan(0);
    expect(swift[swiftName].filter((field) => !carried.includes(field))).toEqual([]);
  });
});
