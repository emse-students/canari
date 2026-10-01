/**
 * Command names for the direct JS -> Rust calls into `tauri-plugin-gallery` (CanaReels C6).
 *
 * Same unchecked-at-compile-time contract as `customTabsCommands.ts`: the prefix is the Tauri
 * plugin name (`Builder::new("gallery")`), NOT the Android class identifier ("app.tauri.gallery"),
 * and each command must be listed in the plugin's `build.rs` COMMANDS array and granted in
 * `permissions/default.toml`, or the IPC boundary refuses it. `galleryCommands.test.ts` pins all of
 * it against the Rust sources.
 */

/** Tauri plugin name - the prefix of the commands below. */
export const GALLERY_PLUGIN = 'gallery';

/** Rust command names (snake_case, as declared in the plugin's `generate_handler!`). */
export const GALLERY_COMMAND_NAMES = {
  saveVideo: 'save_video',
  openAppSettings: 'open_app_settings',
} as const;

/** The header `save_video` reads the file name from - its body is the video itself. */
export const GALLERY_NAME_HEADER = 'x-gallery-name';

/** Fully-qualified `invoke()` identifier for a gallery command. */
export function galleryCommand(name: keyof typeof GALLERY_COMMAND_NAMES): string {
  return `plugin:${GALLERY_PLUGIN}|${GALLERY_COMMAND_NAMES[name]}`;
}
