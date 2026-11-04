import { invoke } from '@tauri-apps/api/core';

/**
 * Command name for the direct JS -> Rust call into `tauri-plugin-customtabs` (WP-OIDC-TAB-1).
 *
 * Same unchecked-at-compile-time contract as `keystoreCommands.ts`: the prefix is the Tauri
 * plugin name (`Builder::new("customtabs")`), NOT the Android class identifier passed to
 * `register_android_plugin` ("app.tauri.customtabs"), and the command must be listed in the
 * plugin's `build.rs` COMMANDS array or the IPC boundary refuses it silently.
 * `nativePluginCommands.test.ts` pins both against the Rust sources.
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

/**
 * How the in-app browser surface ended, as the native side knows it - ONE contract for both
 * platforms, mirrored by `CustomTabOutcome` in the plugin's `src/models.rs`:
 * - `completed` (iOS): the sheet caught the `fr.emse.canari://` redirect and handed it to the
 *   deep-link pipeline - `/auth/callback` takes over from here.
 * - `cancelled` (iOS): the user closed the sheet. Nothing will come back, and no visibility, focus
 *   or foreground edge is raised either - an in-app sheet raises none - so the caller must act on
 *   this answer itself.
 * - `handedOff` (Android): the Custom Tab is an activity the OS owns; its end is the app's
 *   foreground edge, which the login page observes.
 * A failure is not an outcome: the command rejects.
 */
export type CustomTabOutcome = 'completed' | 'cancelled' | 'handedOff';

const CUSTOM_TAB_OUTCOMES: readonly CustomTabOutcome[] = ['completed', 'cancelled', 'handedOff'];

/**
 * Reads the plugin's answer as a {@link CustomTabOutcome}. An answer naming no known outcome is a
 * contract drift between the two sides, thrown as one - never guessed at.
 */
export function parseCustomTabOutcome(answer: unknown): CustomTabOutcome {
  const outcome = (answer as { outcome?: unknown } | null | undefined)?.outcome;
  const known = CUSTOM_TAB_OUTCOMES.find((o) => o === outcome);
  if (!known) {
    throw new Error(`open_custom_tab answered no known outcome: ${JSON.stringify(answer)}`);
  }
  return known;
}

/**
 * Presents `url` in the in-app browser (a Chrome Custom Tab, an ASWebAuthenticationSession) and
 * resolves with how it ended. On iOS that is when the sheet goes away, possibly minutes later - an
 * awaiting caller is held for that long, by design.
 */
export async function openCustomTab(url: string): Promise<CustomTabOutcome> {
  return parseCustomTabOutcome(await invoke(customTabsCommand('openCustomTab'), { url }));
}
