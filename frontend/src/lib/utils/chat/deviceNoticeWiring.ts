import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { AddMessageToChatOptions, Conversation } from '$lib/types';
import type { SvelteMap } from 'svelte/reactivity';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { listRefusedDevices, setRefusedDeviceListener } from '$lib/mls-client/refusedDevices';
import {
  deliverDeviceEvents,
  forgetDeviceNotices,
  loadDeviceNotices,
  noteRefusedOwnDevices,
} from './deviceNotices.svelte';

/** Unbinds the notices from the account that signs out, and stops listening for refusals. */
export function unregisterDeviceNotices(): void {
  setRefusedDeviceListener(null);
  forgetDeviceNotices();
}

/** What the session hands to {@link registerDeviceNotices}; read live, never captured. */
export interface DeviceNoticeSession {
  getUserId: () => string;
  getMyDeviceId: () => string;
  conversations: SvelteMap<string, Conversation>;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    options?: AddMessageToChatOptions
  ) => Promise<void>;
}

/**
 * Claims owner-alert keys in the ledger the phone's background engines share - so a push that
 * replays a commit the app has already shown raises no local notification (`claim_device_notices`,
 * `mobile/device_notice.rs`). Phones only: elsewhere there is no background engine to agree with.
 */
async function claimNativeDeviceNotices(keys: string[]): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  const fresh = await invoke<string[]>('claim_device_notices', { keys });
  console.debug(
    `[DEVICE_NOTICE] native ledger: ${fresh.length} of ${keys.length} key(s) were not yet announced`
  );
}

/**
 * The name the account gave one of its devices, from the device list - best effort: the alert is
 * shown without a name when the list cannot be read, and that is logged.
 */
async function deviceLabelOf(
  mls: IMlsService,
  userId: string,
  deviceId: string
): Promise<string | undefined> {
  try {
    const devices = await mls.fetchUserDevices(userId);
    return devices.find((d) => d.deviceId === deviceId)?.deviceName?.trim() || undefined;
  } catch (e) {
    console.warn('[DEVICE_NOTICE] device list unreadable - alert shown without a name:', e);
    return undefined;
  }
}

/**
 * Binds the new-device notices to the signed-in account and makes them the consumer of the MLS
 * layer's device events - which also drains whatever the sealed state already holds - and the
 * listener of the refusals this device records (`refusedDevices.ts`), so a refused device of the
 * account's own is told to its owner.
 */
export function registerDeviceNotices(mls: IMlsService, session: DeviceNoticeSession): void {
  loadDeviceNotices(session.getUserId());
  const onPhone = isMobileTauriRuntime();
  const refusedCtx = () => ({
    ownUserId: session.getUserId(),
    deviceLabel: (deviceId: string) => deviceLabelOf(mls, session.getUserId(), deviceId),
  });
  // The refusals this device already remembers, then each new one as it is recorded.
  void noteRefusedOwnDevices(
    listRefusedDevices({ userId: session.getUserId(), deviceId: session.getMyDeviceId() }),
    refusedCtx()
  );
  setRefusedDeviceListener((identity) => void noteRefusedOwnDevices([identity], refusedCtx()));
  mls.setDeviceEventConsumer((events) =>
    deliverDeviceEvents(events, {
      ownUserId: session.getUserId(),
      ownDeviceId: session.getMyDeviceId(),
      isDistributionGroup: (groupId) => mls.isDistributionGroup(groupId),
      conversations: session.conversations,
      memberIdentities: (groupId) => mls.getGroupMemberIdentities(groupId),
      addMessageToChat: session.addMessageToChat,
      resolveDisplayNames,
      deviceLabel: (deviceId) => deviceLabelOf(mls, session.getUserId(), deviceId),
      claimNative: onPhone ? claimNativeDeviceNotices : undefined,
      now: () => Date.now(),
    })
  );
}
