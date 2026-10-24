/**
 * Command names for the direct JS -> Rust calls into `tauri-plugin-restore` (WP-RESTORE-1,
 * docs/wiki/account-restore.md).
 *
 * Same unchecked-at-compile-time contract as `customTabsCommands.ts`: the prefix is the Tauri
 * plugin name (`Builder::new("restore")`), NOT the Android class identifier passed to
 * `register_android_plugin` ("app.tauri.restore"), and every command must be listed in the
 * plugin's `build.rs` COMMANDS array or the IPC boundary refuses it silently.
 * `restoreCommands.test.ts` pins both against the Rust sources.
 */

/** Tauri plugin name - the prefix of the commands below. */
export const RESTORE_PLUGIN = 'restore';

/** Rust command names (snake_case, as declared in the plugin's `generate_handler!`). */
export const RESTORE_COMMAND_NAMES = {
  create: 'create_restore_credential',
  get: 'get_restore_credential',
  clear: 'clear_restore_credential',
} as const;

/** Fully-qualified `invoke()` identifier for a restore command. */
export function restoreCommand(name: keyof typeof RESTORE_COMMAND_NAMES): string {
  return `plugin:${RESTORE_PLUGIN}|${RESTORE_COMMAND_NAMES[name]}`;
}
