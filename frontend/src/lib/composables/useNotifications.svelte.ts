/**
 * Reactive composable for audio tone, system (OS-level) notifications,
 * and the channel-membership banner notice.
 */
import { SvelteMap } from 'svelte/reactivity';
import { m } from '$lib/paraglide/messages';
import { notifNav } from '$lib/stores/notifNav.svelte';
import { setTabRinging } from '$lib/stores/tabIndicator';
import { settings } from '$lib/stores/settingsStore.svelte';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { systemNotificationsBlocked } from '$lib/utils/systemNotificationsBlocked';
import {
  isPermissionGranted,
  sendNotification,
  requestPermission,
  removeActive,
  onAction,
} from '@tauri-apps/plugin-notification';

/**
 * THE TWO CHANNELS THIS FILE MAY POST ON, AND WHY THE IDS ARE REPEATED HERE.
 *
 * `CanariApplication.ensureChannels` creates five channels in `Application.onCreate` - so before
 * any component exists, the WebView included - and the ids are Kotlin constants
 * (`CanariFirebaseMessagingService.CHANNEL_*`). Nothing carries them across the FFI, so a
 * notification posted from the WebView has to name one, and naming it wrong is not a cosmetic
 * mistake: `NotificationManagerCompat` DROPS a notification whose channel does not exist.
 *
 * `notificationChannels.test.ts` asserts these two strings against the Kotlin declarations, which
 * is the only thing making this a copy rather than a fork.
 */
/**
 * THE SMALL ICON EVERY NOTIFICATION POSTED FROM HERE MUST NAME, AND WHY IT IS NOT IN `tauri.conf.json`.
 *
 * `TauriNotificationManager.getDefaultSmallIcon` falls back to `android.R.drawable.ic_dialog_info`
 * unless something names a drawable, which is the generic "info" glyph a user reported seeing in
 * place of the Canari bird. The plugin reads a default from its own config (`plugins.notification.icon`)
 * and THAT ROUTE IS CLOSED: `tauri-plugin-notification` 2.3.3 declares `pub fn init<R: Runtime>()`
 * with no config generic, so Tauri infers the config type as `()` and ANY object under
 * `plugins.notification` aborts plugin initialisation. Putting the icon there built, installed, and
 * then crashed the app on every launch with
 *
 *     PluginInitialization("notification", "Error deserializing 'plugins.notification' within your
 *     Tauri configuration: invalid type: map, expected unit")
 *
 * measured on a Mi 9T. The plugin's Android `Config` class carrying `icon`/`sound`/`iconColor` is
 * unreachable in that version. So the per-notification `icon` option is not a second-best here - it
 * is the only one that exists, and it belongs in the mandatory-options helper where a future call
 * site inherits it.
 *
 * `res/drawable-<density>/ic_notification.png` is white-on-transparent at all five densities, which is what
 * Android needs: it draws a small icon from the alpha channel alone.
 */
export const NOTIFICATION_ICON = 'ic_notification';

export const CHANNEL_MESSAGES = 'canari_messages';
export const CHANNEL_CALLS = 'canari_calls';

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

  /**
   * The last browser permission state this session has ANNOUNCED, so a terminal refusal is said once.
   *
   * A permission of `denied` cannot change without a user gesture in site settings, so it is a fact
   * about the session rather than about the message being delivered - and it was being re-derived,
   * re-logged and re-"asked" on every single inbound frame. Remembering the announced VALUE rather
   * than a boolean is what keeps a later granted -> denied transition audible.
   */
  let announcedBrowserPermission: string | null = null;
  let incomingCallRingTimer: ReturnType<typeof setInterval> | null = null;
  /** Active incoming-call OS notification, kept so it can be dismissed on answer/hangup. */
  let incomingCallNotification: Notification | null = null;
  /** Tauri notification id of the active incoming-call notification, for cancellation. */
  let incomingCallNotifId: number | null = null;

  // ---------- Audio ----------

  /**
   * Returns the shared {@link AudioContext}, creating it on first use and resuming it if the
   * browser parked it.
   *
   * The resume is the point. A context constructed before the page has had a user gesture is born
   * `suspended`, and a suspended context accepts every scheduling call without complaint and makes
   * no sound - so the surrounding try/catch sees nothing to catch and the tone is dropped in
   * silence. That is the ordinary case for a tab left alone: a message arrives, this is the first
   * audio the page ever asked for, and it is inaudible. `resume()` may legitimately reject when no
   * gesture has ever happened, which is the browser's decision to make and not an error to report.
   */
  function getAudioContext(): AudioContext {
    audioContext = audioContext ?? new AudioContext();
    if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
    return audioContext;
  }

  /** Plays a two-note descending chime (rate-limited to one every 600 ms) when an incoming message arrives. */
  function playNotificationTone() {
    if (typeof window === 'undefined') return;
    if (!settings.soundsEnabled) return;
    const now = Date.now();
    if (now - lastNotificationAt < 600) return;
    lastNotificationAt = now;

    try {
      const ctx = getAudioContext();
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
      const ctx = getAudioContext();
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
      const ctx = getAudioContext();
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

  /**
   * Stops the incoming-call ring and cancels pending vibration.
   *
   * A NO-OP when nothing is ringing, and the guard is the whole point. Its caller is an `$effect`
   * that runs on every call-state evaluation, so it fires at startup with no call in sight - and
   * `navigator.vibrate(0)` is still a vibrate call, which Chrome refuses without a prior user
   * gesture and reports as a console ERROR. That put two unexplained error lines in every single
   * cold start, on a campaign whose rule is that a run is only clean when every line is accounted
   * for. Cancelling a vibration nobody started is not defensive, it is noise.
   */
  function stopIncomingCallRingtone() {
    if (incomingCallRingTimer === null) return;
    clearInterval(incomingCallRingTimer);
    incomingCallRingTimer = null;
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(0);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Starts blinking the document title to attract attention on an incoming call.
   *
   * DELEGATED, because this used to be a SECOND writer of `document.title` and that is what made it
   * wrong. It saved the current title, blinked over it and restored what it had saved - so an unread
   * prefix present when a call arrived was captured into that save and reinstated after the call
   * ended, and one applied during the call was erased by the restore. `tabIndicator` owns the title
   * now and renders it from (base, unread, bell) each time, which has no such state to lose.
   */
  function startBlinkingTitle() {
    setTabRinging(true);
  }

  /** Stops the title blink; the tab goes back to whatever the unread count says it should read. */
  function stopBlinkingTitle() {
    setTabRinging(false);
  }

  /**
   * The options every Tauri notification on this app must carry, and WHY `largeBody` is not optional.
   *
   * `tauri-plugin-notification` 2.3.3 declares `inbox_lines: Vec<String>` with `#[serde(default)]`
   * and no `skip_serializing_if`, so the Rust side sends `"inboxLines": []` on EVERY notification.
   * Its Android side reads that field as `List<String>? = null` and branches on `!= null` - and an
   * empty array is not null. So every notification it posts is given an `InboxStyle` carrying ZERO
   * lines, and `InboxStyle` renders `textLines`, never `contentText`. The body is in the record and
   * on no screen.
   *
   * Measured on a Mi 9T on 2026-09-06. The notification for a real incoming message read:
   *
   *     android.title     = "Canari Test Beta"
   *     android.text      = "K-mtq268w3ndf quick reply from the shade"   <- decrypted, present
   *     android.template  = "android.app.Notification$InboxStyle"
   *     android.textLines = CharSequence[] (0)                            <- empty
   *
   * and the shade showed the sender's name with nothing under it - which is the user's report of a
   * banner that says who wrote but not what, exactly. It only shows when the notification is ALONE:
   * inside a group the child row falls back to `contentText` and the body reappears, which is why
   * this survived every stacked screenshot anyone had taken.
   *
   * `largeBody` is checked FIRST by that same builder and takes the `BigTextStyle` branch, which
   * renders. This is not a workaround for the sake of one: a message notification wants BigTextStyle,
   * which is what the plugin documents `largeBody` for ("support multiline text"). Passing the body
   * twice is the price of an under-specified call that happened to be papered over by a bug.
   *
   * ONE HELPER RATHER THAN TWO CALL SITES, because the two `sendNotification` calls in this file are
   * a message and an incoming call, and the next one to be added would have been a third chance to
   * post a notification nobody can read.
   *
   * `channelId` JOINED THE MANDATORY SET ON 2026-09-07, for the same reason and from the same kind
   * of measurement. The user reported the small icon of a Canari notification on a Mi 9T as a
   * default "info" glyph, and the live record named both halves of one under-specified call:
   *
   *     Notification(channel=default ... )
   *     icon=Icon(typ=RESOURCE pkg=fr.emse.canari id=0x0108009b)
   *
   * `0x0108009b` is `17301659` is `android.R.drawable.ic_dialog_info` - the resource package byte
   * is `0x01`, the framework, not `0x7f`, the app. So the icon was never ours to begin with:
   * That half is fixed by naming the drawable on every notification this file posts - see
   * `NOTIFICATION_ICON`, which records why the plugin's own config route aborts the app.
   *
   * `channel=default` is the half that is NOT cosmetic. The plugin's own
   * `DEFAULT_NOTIFICATION_CHANNEL_ID = "default"` had been creating a sixth channel beside the five
   * `ensureChannels` designs, at IMPORTANCE_DEFAULT with no sound and no vibration - so a message
   * that arrived while the app was running was quieter than the same message arriving by push, and
   * NONE of the per-channel controls the user is offered (Messages, Mentions, Activite sociale)
   * governed it. Naming the channel is what puts the two paths on one set of settings.
   */
  function androidNotificationOptions(
    body: string,
    channelId: string
  ): { body: string; largeBody: string; channelId: string; icon: string } {
    return { body, largeBody: body, channelId, icon: NOTIFICATION_ICON };
  }

  /**
   * Shows an OS notification for an incoming call.
   * Not rate-limited (unlike message notifications). Tap opens the conversation in /chat.
   */
  async function notifyIncomingCall(callerName: string, groupId: string) {
    if (typeof window === 'undefined') return;

    const title = m.call_incoming_label();
    const body = callerName
      ? m.notif_call_body_named({ caller: callerName })
      : m.notif_call_body_unknown();
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
        if (await isPermissionGranted()) {
          await sendNotification({
            title,
            ...androidNotificationOptions(body, CHANNEL_CALLS),
            id: notifId,
          });
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
      const ctx = getAudioContext();
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

    // A TERMINAL REFUSAL IS KNOWN BEFORE ANY OF THIS, AND ASKING IT PER MESSAGE COSTS THREE LINES A
    // MESSAGE FOR THE LIFE OF THE SESSION. Measured on HEAL-REVOKE-9 (2026-09-07): 12 inbound
    // messages produced 33 `[NOTIF]` lines - "while the window is open ... asking", "permission is
    // \"denied\"; asking", and the throttle firing for notifications that could never be raised.
    //
    // The line that claimed to be asking was also FALSE: `requestSystemNotificationPermission` has
    // no `denied` branch, because a browser will not re-prompt once denied - only the user can
    // change it in site settings. So the work was a guaranteed no-op narrated as an action.
    //
    // Checked BEFORE the throttle on purpose: throttling a notification that cannot be raised
    // burns the per-conversation window and prints a line about a decision that was never live.
    // Guarded on `isTauriRuntime` because on native the plugin's permission is the authority and
    // the web value says nothing - the Tauri branch below is left exactly as it was.
    if (systemNotificationsBlocked()) {
      if (announcedBrowserPermission !== 'denied') {
        announcedBrowserPermission = 'denied';
        console.log(
          '[NOTIF] Not raised, and nothing will be this session - notification permission is "denied", ' +
            'which only the user can change in site settings. Said once; later messages are silent.'
        );
      }
      return;
    }

    const now = Date.now();
    const lastAt = lastNotifAtByConv.get(convKey) ?? 0;
    if (now - lastAt < 800) {
      // EVERY SWALLOWED BRANCH LOGS. Three returns here were silent, so "the user was not notified"
      // and "the code never got there" were the same observation from outside - which is what made
      // TAB-1's zero unattributable for a day.
      console.log(`[NOTIF] Throttled for ${convKey} - ${now - lastAt} ms since the last (800 ms).`);
      return;
    }
    lastNotifAtByConv.set(convKey, now);

    if (isTauriRuntime()) {
      try {
        if (await isPermissionGranted()) {
          await sendNotification({
            title,
            ...androidNotificationOptions(body, CHANNEL_MESSAGES),
            ...(conversationId ? { id: stableNotifId(conversationId) } : {}),
          });
          // TAPPING THIS NOTIFICATION CANNOT REACH THE CONVERSATION ON ANDROID, AND THE PLUGIN IS
          // WHY - measured on a Mi 9T on 2026-09-07 with a real message, which opened the app and
          // landed on nothing.
          //
          // `tauri-plugin-notification` 2.3.3 puts THREE extras on the tap intent: the notification
          // id, the action id, and `notification.sourceJson`. On the way back,
          // `handleNotificationActionPerformed` reads the id, uses it to dismiss the notification,
          // and then DISCARDS it - the payload it emits carries `inputValue`, `actionId` and
          // `notification`, where `notification` is parsed from `sourceJson`. And `sourceJson` is
          // declared `var sourceJson: String? = null` in the plugin's `Notification.kt` and assigned
          // NOWHERE, so the extra is null, so the payload's `notification` is null.
          //
          // The listener below therefore received `null` and threw on `.id` inside an async
          // callback - an unhandled rejection nothing logged, which is why a tap that did nothing
          // looked like a tap that did nothing on purpose. The guard makes the platform say so.
          //
          // THE FIX IS NOT HERE. The Kotlin path carries identity properly - its tap is
          // `ACTION_VIEW` on `fr.emse.canari://chat/<groupId>`, a deep link the app already handles
          // - and the plugin hardcodes `ACTION_MAIN` on the launcher activity with no way to pass a
          // link. So the durable answer is for ONE builder to post every notification, natively,
          // and for this call site to ask it rather than post its own. That is a new native command
          // and it is filed as such; see docs/wiki/backlog.md.
          //
          // Kept rather than deleted because desktop is a different implementation (`desktop.rs`,
          // notify-rust) and this session measured Android only. Deleting it would trade a known
          // broken path for an unmeasured claim about another one.
          if (conversationId) {
            try {
              if (typeof onAction === 'function') {
                (
                  onAction as unknown as (
                    cb: (action: { notification?: { id?: number } | null }) => void
                  ) => Promise<unknown>
                )(async (action) => {
                  if (!action?.notification) {
                    console.warn(
                      '[NOTIF] A notification tap arrived carrying no notification identity, so it ' +
                        'cannot be routed to a conversation. This is tauri-plugin-notification ' +
                        'never populating sourceJson; the notification must be posted natively ' +
                        'instead. Opening nothing.'
                    );
                    return;
                  }
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

    if (!('Notification' in window)) {
      console.log(`[NOTIF] Not raised for ${convKey} - this engine exposes no Notification API.`);
      return;
    }
    {
      if (Notification.permission !== 'granted') {
        // `default` by the time we get here on web - the terminal `denied` returned at the top - so
        // this line now describes something that really is about to happen. A Tauri run whose
        // plugin path fell through can still arrive here with `denied`, and saying so once is right
        // for the same reason it is right above.
        if (Notification.permission === 'denied') {
          if (announcedBrowserPermission !== 'denied') {
            announcedBrowserPermission = 'denied';
            console.log(
              `[NOTIF] Not raised for ${convKey} - permission is "denied" and only the user can change it.`
            );
          }
          return;
        }
        console.log(`[NOTIF] Not raised for ${convKey} - permission is "default"; asking.`);
        void requestSystemNotificationPermission();
        return;
      }
      // Reset the announcement so a later revocation is audible rather than swallowed by a flag set
      // in a state the session has since left.
      announcedBrowserPermission = 'granted';

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
        console.log(`[NOTIF] Raised for ${convKey}.`);
        setTimeout(() => n.close(), 8000);
      } catch (e) {
        // A browser refuses a Notification for reasons a page cannot test for in advance, and an
        // empty catch here is indistinguishable from never having tried.
        console.log(`[NOTIF] Constructor threw for ${convKey}: ${String(e)}`);
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
    startBlinkingTitle,
    stopBlinkingTitle,
    notifyIncomingCall,
    dismissIncomingCall,
  };
}
