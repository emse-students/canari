/**
 * Reactive composable for audio tone, system (OS-level) notifications,
 * and the channel-membership banner notice.
 */
import { SvelteMap } from 'svelte/reactivity';
import { notifNav } from '$lib/stores/notifNav.svelte';
import { settings } from '$lib/stores/settingsStore.svelte';
import { isTauriRuntime } from '$lib/utils/openExternal';

/** Returns a stable positive integer ID derived from a conversation ID string, used to replace existing Tauri notifications for the same conversation. */
function stableNotifId(conversationId: string): number {
  let hash = 0;
  for (let i = 0; i < conversationId.length; i++) {
    hash = (Math.imul(31, hash) + conversationId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

export function useNotifications() {
  let audioContext = $state<AudioContext | null>(null);
  let lastNotificationAt = $state(0);
  let lastSendToneAt = $state(0);
  let lastReadToneAt = $state(0);
  // Per-conversation rate limit: conversationId → last notification timestamp.
  // Prevents notification spam on burst but lets different conversations notify independently.
  const lastNotifAtByConv = new SvelteMap<string, number>();
  let browserPermissionRetryAbort: AbortController | null = null;
  let incomingCallRingTimer: ReturnType<typeof setInterval> | null = null;
  /** Active incoming-call OS notification, kept so it can be dismissed on answer/hangup. */
  let incomingCallNotification: Notification | null = null;
  /** Tauri notification id of the active incoming-call notification, for cancellation. */
  let incomingCallNotifId: number | null = null;

  // ---------- Audio ----------

  /** Plays a two-note descending chime (rate-limited to one every 600 ms) when an incoming message arrives. */
  function playNotificationTone() {
    if (typeof window === 'undefined') return;
    if (!settings.soundsEnabled) return;
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
      // Browser/autoplay restriction - silently ignored.
    }
  }

  /** Plays a short ascending chirp when the user sends a message (rate-limited to one every 200 ms). */
  function playSendTone() {
    if (typeof window === 'undefined') return;
    if (!settings.soundsEnabled) return;
    const now = Date.now();
    if (now - lastSendToneAt < 200) return;
    lastSendToneAt = now;

    try {
      audioContext = audioContext ?? new AudioContext();
      const ctx = audioContext;
      const startAt = ctx.currentTime + 0.01;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(740, startAt);
      osc.frequency.exponentialRampToValueAtTime(980, startAt + 0.08);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.05, startAt + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.11);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + 0.12);
    } catch {
      // Browser/autoplay restriction - silently ignored.
    }
  }

  /** Alias for playNotificationTone - used when a message is received from another user. */
  function playReceiveTone() {
    playNotificationTone();
  }

  /** Plays one cycle of a classic dual-tone ring (best-effort; respects soundsEnabled). */
  function playIncomingCallRingBurst() {
    if (typeof window === 'undefined') return;
    if (!settings.soundsEnabled) return;

    try {
      audioContext = audioContext ?? new AudioContext();
      const ctx = audioContext;
      const startAt = ctx.currentTime + 0.01;

      for (const [freq, offset] of [
        [440, 0],
        [480, 0.25],
      ] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, startAt + offset);
        gain.gain.setValueAtTime(0.0001, startAt + offset);
        gain.gain.exponentialRampToValueAtTime(0.12, startAt + offset + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.22);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startAt + offset);
        osc.stop(startAt + offset + 0.24);
      }
    } catch {
      /* autoplay restriction */
    }
  }

  /** Starts repeating the incoming-call ring until {@link stopIncomingCallRingtone}. */
  function startIncomingCallRingtone() {
    if (typeof window === 'undefined') return;
    stopIncomingCallRingtone();
    playIncomingCallRingBurst();
    incomingCallRingTimer = setInterval(playIncomingCallRingBurst, 2_400);
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate([400, 200, 400, 200, 400]);
      } catch {
        /* ignore */
      }
    }
  }

  /** Stops the incoming-call ring and cancels pending vibration. */
  function stopIncomingCallRingtone() {
    if (incomingCallRingTimer !== null) {
      clearInterval(incomingCallRingTimer);
      incomingCallRingTimer = null;
    }
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(0);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Shows an OS notification for an incoming call.
   * Not rate-limited (unlike message notifications). Tap opens the conversation in /chat.
   */
  async function notifyIncomingCall(callerName: string, groupId: string) {
    if (typeof window === 'undefined') return;

    const title = 'Appel entrant';
    const body = callerName ? `${callerName} vous appelle` : 'Un contact vous appelle';
    const notifId = stableNotifId(`call:${groupId}`);

    const onTap = async () => {
      notifNav.navigate(groupId);
      try {
        const { goto } = await import('$app/navigation');
        await goto('/chat');
      } catch {
        /* ignore */
      }
      try {
        window.focus();
      } catch {
        /* ignore */
      }
    };

    if (isTauriRuntime()) {
      try {
        const { isPermissionGranted, sendNotification } =
          await import('@tauri-apps/plugin-notification');
        if (await isPermissionGranted()) {
          await sendNotification({ title, body, id: notifId });
          incomingCallNotifId = notifId;
          return;
        }
      } catch {
        /* fallback */
      }
    }

    if ('Notification' in window) {
      if (Notification.permission !== 'granted') {
        void requestSystemNotificationPermission();
        return;
      }
      try {
        const n = new Notification(title, {
          body,
          tag: `canari-call-${groupId}`,
          requireInteraction: true,
        });
        // Keep the ref so dismissIncomingCall() can close it once the call is
        // answered or ends (requireInteraction keeps it on screen otherwise).
        incomingCallNotification = n;
        n.onclick = () => {
          void onTap();
          n.close();
          incomingCallNotification = null;
        };
        n.onclose = () => {
          if (incomingCallNotification === n) incomingCallNotification = null;
        };
      } catch {
        /* ignore */
      }
    }
  }

  /** Dismisses the incoming-call OS notification (call answered, declined, or ended). */
  async function dismissIncomingCall() {
    if (incomingCallNotification) {
      try {
        incomingCallNotification.close();
      } catch {
        /* ignore */
      }
      incomingCallNotification = null;
    }
    if (incomingCallNotifId !== null && isTauriRuntime()) {
      const id = incomingCallNotifId;
      incomingCallNotifId = null;
      try {
        const { removeActive } = await import('@tauri-apps/plugin-notification');
        await removeActive([{ id }]);
      } catch {
        /* plugin/API unavailable - ignore */
      }
    }
  }

  /** Plays a subtle descending tick when messages are marked as read (rate-limited to one every 250 ms). */
  function playReadTone() {
    if (typeof window === 'undefined') return;
    if (!settings.soundsEnabled) return;
    const now = Date.now();
    if (now - lastReadToneAt < 250) return;
    lastReadToneAt = now;

    try {
      audioContext = audioContext ?? new AudioContext();
      const ctx = audioContext;
      const startAt = ctx.currentTime + 0.01;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1080, startAt);
      osc.frequency.exponentialRampToValueAtTime(820, startAt + 0.07);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.04, startAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.09);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + 0.1);
    } catch {
      // Browser/autoplay restriction - silently ignored.
    }
  }

  // ---------- System (OS-level) notifications ----------

  /** Registers a one-shot user-gesture listener (pointerdown / keydown / touchstart) to request Notification permission the next time the user interacts with the page. */
  function installBrowserPermissionRetry() {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (browserPermissionRetryAbort || Notification.permission !== 'default') return;

    const abort = new AbortController();
    browserPermissionRetryAbort = abort;

    const requestFromGesture = () => {
      void (async () => {
        try {
          await Notification.requestPermission();
        } catch {
          /* ignore */
        } finally {
          abort.abort();
          browserPermissionRetryAbort = null;
        }
      })();
    };

    for (const eventName of ['pointerdown', 'keydown', 'touchstart'] as const) {
      window.addEventListener(eventName, requestFromGesture, {
        once: true,
        signal: abort.signal,
      });
    }
  }

  /** Requests OS-level notification permission. On Tauri skips Linux desktop (WebKitGTK dbus deadlock); on web uses the Notification API and falls back to installBrowserPermissionRetry if the prompt is dismissed. */
  async function requestSystemNotificationPermission() {
    if (typeof window === 'undefined') return;

    if (isTauriRuntime()) {
      // On Tauri Linux desktop, the notification plugin blocks the GLib main loop
      // (the dbus call never returns in WebKitGTK). Skip on pure Linux.
      // On Android 13+, POST_NOTIFICATIONS permission MUST be requested at runtime
      // via the Tauri plugin (the manifest alone is not enough).
      // Reliable detection: Linux desktop = "Linux" in platform/userAgent WITHOUT "Android".
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
      const isLinuxDesktop = /linux/i.test(ua) && !/android/i.test(ua) && !/cros/i.test(ua);
      if (isLinuxDesktop) {
        // Tauri on Linux desktop: the dbus/GLib event loop deadlocks when the
        // notification plugin tries to request permission via WebKitGTK.
        // Notifications are intentionally disabled on this platform.
        console.info(
          '[Push] Notifications disabled on Tauri Linux desktop (dbus/GLib/WebKitGTK bug).'
        );
        return;
      }
      try {
        const { isPermissionGranted, requestPermission } =
          await import('@tauri-apps/plugin-notification');
        let granted = await isPermissionGranted();
        if (!granted) {
          const result = await requestPermission();
          granted = result === 'granted';
        }
        console.log('[Push] Permission granted:', granted);
      } catch {
        /* plugin unavailable on this platform */
      }
      return;
    }

    if (!('Notification' in window)) return;

    if (Notification.permission === 'granted') {
      browserPermissionRetryAbort?.abort();
      browserPermissionRetryAbort = null;
      return;
    }

    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }

      if (Notification.permission === 'default') {
        installBrowserPermissionRetry();
      }
    }
  }

  /** Shows an OS-level notification (via Tauri plugin or Web Notification API). Rate-limited per conversation to 800 ms to absorb bursts while allowing different conversations to notify independently. Uses a stable ID/tag per conversation so successive messages replace rather than stack. */
  async function sendSystemNotification(title: string, body: string, conversationId?: string) {
    if (typeof window === 'undefined') return;
    const convKey = conversationId ?? '__default__';
    const now = Date.now();
    const lastAt = lastNotifAtByConv.get(convKey) ?? 0;
    if (now - lastAt < 800) return;
    lastNotifAtByConv.set(convKey, now);

    if (isTauriRuntime()) {
      try {
        const { isPermissionGranted, sendNotification } =
          await import('@tauri-apps/plugin-notification');
        if (await isPermissionGranted()) {
          await sendNotification({
            title,
            body,
            ...(conversationId ? { id: stableNotifId(conversationId) } : {}),
          });
          // Best-effort: register a tap action so tapping the notification on
          // Tauri desktop navigates to the conversation (parity with Web onclick).
          // onAction is only available on some Tauri notification plugin versions.
          if (conversationId) {
            try {
              const notifPlugin = await import('@tauri-apps/plugin-notification');
              if ('onAction' in notifPlugin && typeof notifPlugin.onAction === 'function') {
                (
                  notifPlugin.onAction as unknown as (
                    cb: (action: { notification: { id?: number } }) => void
                  ) => Promise<unknown>
                )(async (action) => {
                  if (action.notification.id === stableNotifId(conversationId)) {
                    notifNav.navigate(conversationId);
                    try {
                      const { goto } = await import('$app/navigation');
                      await goto('/chat');
                    } catch {
                      /* ignore */
                    }
                  }
                });
              }
            } catch {
              /* onAction unavailable on this platform/version */
            }
          }
        }
        return;
      } catch {
        /* fallback to web */
      }
    }

    if ('Notification' in window) {
      if (Notification.permission !== 'granted') {
        void requestSystemNotificationPermission();
        return;
      }

      try {
        const n = new Notification(title, {
          body,
          tag: `canari-${conversationId ?? 'message'}`,
        });
        n.onclick = async () => {
          try {
            window.focus();
          } catch {
            /* ignore */
          }
          if (conversationId) {
            notifNav.navigate(conversationId);
            try {
              const { goto } = await import('$app/navigation');
              await goto('/chat');
            } catch {
              /* ignore */
            }
          }
          n.close();
        };
        setTimeout(() => n.close(), 8000);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    playNotificationTone,
    playSendTone,
    playReceiveTone,
    playReadTone,
    requestSystemNotificationPermission,
    sendSystemNotification,
    startIncomingCallRingtone,
    stopIncomingCallRingtone,
    notifyIncomingCall,
    dismissIncomingCall,
  };
}
