import { checkAppVersion, type AppVersionCheckResult } from '$lib/utils/appVersion';

let lastCheck = $state<AppVersionCheckResult | null>(null);
let checking = $state(false);
let updatePromptDismissed = $state(false);

/** Latest version check result, or null before the first run. */
export function getAppVersionCheck(): AppVersionCheckResult | null {
  return lastCheck;
}

/** True when the server reports a newer build than this client. */
export function isAppUpdateAvailable(): boolean {
  return lastCheck !== null && !lastCheck.upToDate && !updatePromptDismissed;
}

/** Hides the update modal until the next version check (e.g. on window focus). */
export function dismissAppUpdatePrompt(): void {
  updatePromptDismissed = true;
}

/**
 * Calls `GET /api/version` and updates {@link getAppVersionCheck}.
 * Safe to call repeatedly (e.g. on app focus).
 */
export async function refreshAppVersionCheck(): Promise<AppVersionCheckResult> {
  if (checking) return lastCheck ?? (await checkAppVersion());
  checking = true;
  try {
    const previousServer = lastCheck?.serverVersion ?? null;
    lastCheck = await checkAppVersion();
    if (lastCheck.upToDate || lastCheck.serverVersion !== previousServer) {
      updatePromptDismissed = false;
    }
    return lastCheck;
  } finally {
    checking = false;
  }
}
