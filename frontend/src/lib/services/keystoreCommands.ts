/**
 * Command names for the direct JS -> Rust calls into `tauri-plugin-keystore`.
 *
 * Two independent things have to line up for one of these to work at runtime, and NEITHER is
 * checked by a compiler:
 *
 *  1. The prefix is the TAURI plugin name (`Builder::new("keystore")` in the plugin's `lib.rs`),
 *     NOT the Android class identifier passed to `register_android_plugin` ("app.tauri.keystore").
 *     Getting that wrong resolves no plugin at all, and `invoke` rejects with an error that every
 *     call site here swallows.
 *  2. The command must be listed in the plugin's `build.rs` COMMANDS array, which generates the
 *     ACL. A command absent from it is refused at the IPC boundary even when the Rust function
 *     exists and the name is spelled right.
 *
 * Both were wrong until v0.11.4: `isKeyPresent` always returned false, so biometric unlock became
 * unreachable the moment it was enrolled. `keystoreCommands.test.ts` now pins the names against
 * the Rust sources.
 */

/** Tauri plugin name - the prefix of every command below. */
export const KEYSTORE_PLUGIN = 'keystore';

/** Rust command names (snake_case, as declared in the plugin's `generate_handler!`). */
export const KEYSTORE_COMMAND_NAMES = {
  storeKeyBytes: 'store_key_bytes',
  getKeyBytes: 'get_key_bytes',
  deleteKeyBytes: 'delete_key_bytes',
  hasKeyBytes: 'has_key_bytes',
} as const;

/** Fully-qualified `invoke()` identifier for a keystore command. */
export function keystoreCommand(name: keyof typeof KEYSTORE_COMMAND_NAMES): string {
  return `plugin:${KEYSTORE_PLUGIN}|${KEYSTORE_COMMAND_NAMES[name]}`;
}
