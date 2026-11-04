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

/** Tauri plugin name - the prefix of the commands below. */
export const SYSTEM_COMPONENTS_PLUGIN = 'system-components';

/** Rust command names (snake_case, as declared in the plugin's `generate_handler!`). */
export const SYSTEM_COMPONENTS_COMMAND_NAMES = {
  setTabBarInteractive: 'set_tab_bar_interactive',
} as const;

/** Fully-qualified `invoke()` identifier for a patched system-components command. */
export function systemComponentsCommand(
  name: keyof typeof SYSTEM_COMPONENTS_COMMAND_NAMES
): string {
  return `plugin:${SYSTEM_COMPONENTS_PLUGIN}|${SYSTEM_COMPONENTS_COMMAND_NAMES[name]}`;
}
