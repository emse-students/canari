/**
 * Command name for the direct JS -> Rust call into `tauri-plugin-customtabs` (WP-OIDC-TAB-1).
 *
 * Same unchecked-at-compile-time contract as `keystoreCommands.ts`: the prefix is the Tauri
 * plugin name (`Builder::new("customtabs")`), NOT the Android class identifier passed to
 * `register_android_plugin` ("app.tauri.customtabs"), and the command must be listed in the
 * plugin's `build.rs` COMMANDS array or the IPC boundary refuses it silently.
 * `customTabsCommands.test.ts` pins both against the Rust sources.
 */

/** Tauri plugin name - the prefix of the command below. */
export const CUSTOM_TABS_PLUGIN = 'customtabs';

/** Rust command name (snake_case, as declared in the plugin's `generate_handler!`). */
export const CUSTOM_TABS_COMMAND_NAMES = {
  openCustomTab: 'open_custom_tab',
} as const;

/** Fully-qualified `invoke()` identifier for the custom-tabs command. */
export function customTabsCommand(name: keyof typeof CUSTOM_TABS_COMMAND_NAMES): string {
  return `plugin:${CUSTOM_TABS_PLUGIN}|${CUSTOM_TABS_COMMAND_NAMES[name]}`;
}
