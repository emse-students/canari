/**
 * Command names for the CANARI-PATCHED commands of `tauri-plugin-system-components` - the ones its
 * published JS API (`@sosweetham/tauri-plugin-system-components-api`) does not carry, so they are
 * invoked by name here.
 *
 * Same unchecked-at-compile-time contract as `customTabsCommands.ts`: the prefix is the Tauri plugin
 * name (`Builder::new("system-components")`), and the command must be in the plugin's `build.rs`
 * COMMANDS array and its default permission set, or the IPC boundary refuses it.
 * `nativePluginCommands.test.ts` pins all three against the patched sources.
 */

import { invoke } from '@tauri-apps/api/core';
import { Log } from '$lib/utils/Log';

/** Tauri plugin name - the prefix of the commands below. */
export const SYSTEM_COMPONENTS_PLUGIN = 'system-components';

/** Rust command names (snake_case, as declared in the plugin's `generate_handler!`). */
export const SYSTEM_COMPONENTS_COMMAND_NAMES = {
  setTabBarInteractive: 'set_tab_bar_interactive',
  // Upstream commands, patched to take a `seq`, which the published API does not send.
  showTabBar: 'show_tab_bar',
  hideTabBar: 'hide_tab_bar',
} as const;

/** Fully-qualified `invoke()` identifier for a patched system-components command. */
export function systemComponentsCommand(
  name: keyof typeof SYSTEM_COMPONENTS_COMMAND_NAMES
): string {
  return `plugin:${SYSTEM_COMPONENTS_PLUGIN}|${SYSTEM_COMPONENTS_COMMAND_NAMES[name]}`;
}

/** The last sequence stamped - one counter for every sequenced command of this page. */
let lastSeq = 0;

/**
 * Invokes a sequenced tab-bar command, stamped with a `seq` that rises with EVERY such call.
 *
 * WHY: the plugin's commands are async on the Rust side, each on its own runtime worker, so two
 * quick calls (a hide then a show as the keyboard closes and a conversation opens) may reach the
 * iOS main queue in the reverse order. Swift's `CommandSequence` drops a call older than the last
 * one it applied for the same state, and a configuration resets it - a reloaded page counts from 1.
 * One counter serves every command: Swift compares within one state only, so a gap is harmless.
 * Returns the `seq`, so a caller can tell whether its answer is still the newest call it made.
 */
export function invokeSequenced(
  name: keyof typeof SYSTEM_COMPONENTS_COMMAND_NAMES,
  fields: Record<string, unknown> = {}
): { seq: number; answered: Promise<unknown> } {
  const seq = ++lastSeq;
  Log.d('systemComponents', `${name} seq=${seq}`);
  return { seq, answered: invoke(systemComponentsCommand(name), { options: { ...fields, seq } }) };
}
