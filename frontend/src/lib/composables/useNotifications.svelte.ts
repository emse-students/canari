/**
 * Reactive composable for audio tone, system (OS-level) notifications,
 * and the channel-membership banner notice.
 */

export function useNotifications() {
  let audioContext = $state<AudioContext | null>(null);
  let lastNotificationAt = $state(0);
  let lastSystemNotificationAt = $state(0);

  // Channel membership notice banner
  let channelMembershipNotice = $state('');
  let channelMembershipActionChannelId = $state<string | null>(null);
  let channelMembershipNoticeTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------- Audio ----------

  function playNotificationTone() {
    if (typeof window === 'undefined') return;
    const now = Date.now();
    if (now - lastNotificationAt < 600) return;
    lastNotificationAt = now;

    try {
      audioContext = audioContext ?? new AudioContext();
      const ctx = audioContext;
      const startAt = ctx.currentTime + 0.01;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(920, startAt);
      osc.frequency.exponentialRampToValueAtTime(680, startAt + 0.11);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.08, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + 0.16);
    } catch {
      // Browser/autoplay restriction — silently ignored.
    }
  }

  // ---------- System (OS-level) notifications ----------

  async function requestSystemNotificationPermission() {
    if (typeof window === 'undefined') return;

    if ((window as any).__TAURI_INTERNALS__) {
      try {
        const { isPermissionGranted, requestPermission } =
          await import('@tauri-apps/plugin-notification');
        const granted = await isPermissionGranted();
        if (!granted) await requestPermission();
      } catch {
        /* plugin unavailable */
      }
      return;
    }

    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }
    }
  }

  async function sendSystemNotification(title: string, body: string) {
    if (typeof window === 'undefined') return;
    const now = Date.now();
    if (now - lastSystemNotificationAt < 800) return;
    lastSystemNotificationAt = now;

    if ((window as any).__TAURI_INTERNALS__) {
      try {
        const { isPermissionGranted, sendNotification } =
          await import('@tauri-apps/plugin-notification');
        if (await isPermissionGranted()) {
          await sendNotification({ title, body });
        }
        return;
      } catch {
        /* fallback to web */
      }
    }

    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(title, { body, tag: 'canari-message' });
        setTimeout(() => n.close(), 5000);
      } catch {
        /* ignore */
      }
    }
  }

  // ---------- Channel membership banner ----------

  function showChannelMembershipNotice(message: string, actionChannelId?: string) {
    channelMembershipNotice = message;
    channelMembershipActionChannelId = actionChannelId ?? null;

    if (channelMembershipNoticeTimer) clearTimeout(channelMembershipNoticeTimer);
    channelMembershipNoticeTimer = setTimeout(() => {
      channelMembershipNotice = '';
      channelMembershipActionChannelId = null;
      channelMembershipNoticeTimer = null;
    }, 5000);
  }

  function openJoinedChannelFromNotice(
    selectConversation: (id: string) => void,
    setSelectedChannelId: (id: string) => void
  ) {
    if (!channelMembershipActionChannelId) return;
    setSelectedChannelId(channelMembershipActionChannelId);
    selectConversation(channelMembershipActionChannelId);
    channelMembershipNotice = '';
    channelMembershipActionChannelId = null;
    if (channelMembershipNoticeTimer) {
      clearTimeout(channelMembershipNoticeTimer);
      channelMembershipNoticeTimer = null;
    }
  }

  function clearActionChannel(channelId: string) {
    if (channelMembershipActionChannelId === channelId) {
      channelMembershipActionChannelId = null;
    }
  }

  return {
    get channelMembershipNotice() {
      return channelMembershipNotice;
    },
    get channelMembershipActionChannelId() {
      return channelMembershipActionChannelId;
    },
    playNotificationTone,
    requestSystemNotificationPermission,
    sendSystemNotification,
    showChannelMembershipNotice,
    openJoinedChannelFromNotice,
    clearActionChannel,
  };
}
