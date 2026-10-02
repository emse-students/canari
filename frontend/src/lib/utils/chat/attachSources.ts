import { detectRuntimeDeviceOs } from '$lib/mls-client/mlsPlatform';
import { isAndroidTauriRuntime, isIosTauriRuntime } from '$lib/utils/appVersion';

/**
 * THE COMPOSER OFFERS ONE ATTACHMENT MENU, AND EACH ENTRY GOES STRAIGHT TO ITS PICKER (user,
 * 2026-10-02, iPhone: *"deux menus similaires, n'en faire qu'un"*).
 *
 * WHY THERE WERE TWO. Canari's "+" offered "Photos et videos"; that entry clicked an
 * `<input type="file" accept="image/*,video/*">`, and on iOS WebKit answers ANY file input that
 * accepts images or videos and carries no `capture` with its own sheet - Phototheque, Prendre une
 * photo ou une video, Choisir les fichiers (`WKFileUploadPanel`). No `accept` a page can write skips
 * that sheet. So the second menu is not a bug of ours to tune away: it is what a file input IS on iOS,
 * and the only way to one menu is to not open a file input for the entries the sheet duplicates.
 *
 * What each entry opens, per runtime:
 *
 * | runtime | library | camera | files |
 * | --- | --- | --- | --- |
 * | iOS app | native PHPicker (`tauri-plugin-dialog`) | input + `capture` (WebKit opens the camera directly) | native document picker |
 * | Android app, phone browser on Android | input `image/*,video/*` (the system photo picker) | two inputs + `capture`: photo, video | input, every type |
 * | phone browser on iOS | NO Canari menu: one input, and WebKit's sheet IS the menu | - | - |
 * | desktop | NO menu: the paperclip opens the file dialog | - | - |
 *
 * Android needs two camera entries because its capture intents are one or the other: with both
 * types accepted, wry's `RustWebChromeClient.onShowFileChooser` launches the VIDEO recorder only.
 * iOS's camera switches between photo and video itself, so one entry.
 */
export type AttachSource = 'library' | 'camera' | 'camera-photo' | 'camera-video' | 'files';

/** Where the composer runs, as far as picking a file is concerned. */
export type AttachRuntime = 'ios-app' | 'android-app' | 'ios-web' | 'android-web' | 'desktop';

/** Every type the composer can send - the "all files" entry, and the desktop dialog. */
export const ALL_FILES_ACCEPT = 'image/*,video/*,audio/*,application/pdf,.doc,.docx,.zip';

/** What an `<input>` opened for `source` accepts. */
export function acceptFor(source: AttachSource): string {
  switch (source) {
    case 'library':
    case 'camera':
      return 'image/*,video/*';
    case 'camera-photo':
      return 'image/*';
    case 'camera-video':
      return 'video/*';
    case 'files':
      return ALL_FILES_ACCEPT;
  }
}

/** Whether an `<input>` for `source` carries `capture` - the camera, never a chooser. */
export function capturesFor(source: AttachSource): boolean {
  return source === 'camera' || source === 'camera-photo' || source === 'camera-video';
}

/** Whether `source` may pick several files at once (a camera takes one). */
export function multipleFor(source: AttachSource): boolean {
  return !capturesFor(source);
}

/**
 * The runtime, from facts the platform states: the compile-time target inside the apps, the OS the
 * browser reports otherwise, and the layout width (a desktop browser on a narrow window is still a
 * desktop - it has a mouse and a file dialog).
 */
export function attachRuntimeFrom(facts: {
  iosApp: boolean;
  androidApp: boolean;
  os: string;
  narrow: boolean;
}): AttachRuntime {
  if (facts.iosApp) return 'ios-app';
  if (facts.androidApp) return 'android-app';
  if (!facts.narrow) return 'desktop';
  if (facts.os === 'ios') return 'ios-web';
  if (facts.os === 'android') return 'android-web';
  return 'desktop';
}

/** {@link attachRuntimeFrom} for the running page. */
export function currentAttachRuntime(narrow: boolean): AttachRuntime {
  return attachRuntimeFrom({
    iosApp: isIosTauriRuntime(),
    androidApp: isAndroidTauriRuntime(),
    os: detectRuntimeDeviceOs(),
    narrow,
  });
}

/**
 * The entries Canari's own menu offers, in order. EMPTY means Canari draws no attachment menu: the
 * paperclip opens one picker directly (desktop), or the system's own sheet is the menu (iOS web).
 */
export function attachSourcesFor(runtime: AttachRuntime): AttachSource[] {
  switch (runtime) {
    case 'ios-app':
      return ['library', 'camera', 'files'];
    case 'android-app':
    case 'android-web':
      return ['library', 'camera-photo', 'camera-video', 'files'];
    case 'ios-web':
    case 'desktop':
      return [];
  }
}

/** Whether `source` is opened by a NATIVE picker rather than a file input (the iOS app's two). */
export function opensNatively(runtime: AttachRuntime, source: AttachSource): boolean {
  return runtime === 'ios-app' && (source === 'library' || source === 'files');
}
