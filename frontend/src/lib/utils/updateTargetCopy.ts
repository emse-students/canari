import type { UpdateTargetKind } from '$lib/utils/appVersion';
import { m } from '$lib/paraglide/messages';

/**
 * Localized copy for an {@link UpdateTargetKind}. Shared by the blocking gate
 * (PlatformGateOverlay) and the informational block in the settings page, which must never
 * disagree about where this install gets its updates: the Android wording in particular
 * depends on the install source, not on the platform.
 */

/** One sentence telling the user what the update action is about to do. */
export function updateTargetInstruction(kind: UpdateTargetKind): string {
  switch (kind) {
    case 'play':
      return m.update_play_store_instruction();
    case 'appstore':
      return m.update_ios_instruction();
    case 'apk':
      return m.update_android_instruction();
    case 'releasePage':
      return m.update_native_instruction();
    case 'reload':
      return m.update_web_instruction();
  }
}

/** Label of the button that opens the target. */
export function updateTargetButtonLabel(kind: UpdateTargetKind): string {
  switch (kind) {
    case 'play':
      return m.update_open_play_store_button();
    case 'appstore':
      return m.update_open_app_store_button();
    case 'apk':
    case 'releasePage':
      return m.update_download_button();
    case 'reload':
      return m.update_reload_button();
  }
}
