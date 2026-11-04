import { addPluginListener, type PluginListener } from '@tauri-apps/api/core';
import { SYSTEM_COMPONENTS_PLUGIN } from '$lib/services/systemComponentsCommands';
import { Log } from '$lib/utils/Log';

/**
 * The plugin event the Canari patch triggers on a tap of the iOS status bar (`StatusBarTapCatcher`,
 * `TabBarOverlay.swift`). WKWebView scrolls its OWN scroll view to the top on that tap, and the app's
 * pages scroll in an inner box instead, so the native side swallows the tap and tells the page.
 */
export const STATUS_BAR_TAP_EVENT = 'statusBarTap';

/** Subscribes to status bar taps; the caller unregisters the returned listener. */
export function onStatusBarTap(handler: () => void): Promise<PluginListener> {
  return addPluginListener(SYSTEM_COMPONENTS_PLUGIN, STATUS_BAR_TAP_EVENT, () => {
    Log.d('NativeStatusBarTap', 'status bar tapped');
    handler();
  });
}
