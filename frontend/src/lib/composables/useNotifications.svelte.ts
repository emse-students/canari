/**
 * Reactive composable for audio tone, system (OS-level) notifications,
 * and the channel-membership banner notice.
 */
import { SvelteMap } from 'svelte/reactivity';
import { m } from '$lib/paraglide/messages';
import { notifNav } from '$lib/stores/notifNav.svelte';
import {
  armPageTapListener,
  routePageNotificationTap,
  type RegisterPageTap,
} from '$lib/utils/chat/pageNotificationTap';
import { setTabRinging } from '$lib/stores/tabIndicator';
import { settings } from '$lib/stores/settingsStore.svelte';
import { playTone } from '$lib/utils/toneOutput';
import { startCallRing, stopCallRing } from '$lib/utils/callRing';
import { callHoldsAppSound } from '$lib/utils/callSoundGate';
import { scoreSound } from '$lib/utils/soundPalette';
import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
import {
  composePlainNotificationText,
  postNativeMessageNotification,
  postNativeReactionNotification,
  type NativeMessageNotification,
  type NativeReactionNotification,
} from '$lib/utils/nativeNotification';
import { reactionCollapseKey, reactionNotificationKey } from '$lib/utils/chat/reactionNotification';
import { stableNotifId } from '$lib/utils/stableNotifId';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { appendLog } from '$lib/utils/sessionLog';
import { systemNotificationsBlockedAnnounceOnce } from '$lib/utils/systemNotificationsBlocked';
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

/**
 * THE `_v2` CHANNELS CARRY THE PALETTE-A SOUNDS (2026-10-09), AND THE CALLS CHANNEL CANARI'S RING
 * (2026-11-01). A channel's sound is IMMUTABLE once Android has created it, so changing the sound
 * meant new ids; `CanariApplication` deletes the old `canari_messages` / `canari_mentions` /
 * `canari_reactions` / `canari_calls` at startup. The ids are the same strings in Kotlin, the
 * manifest and here, pinned by `notificationChannels.test.ts`.
 */
export const CHANNEL_MESSAGES = 'canari_messages_v2';
export const CHANNEL_CALLS = 'canari_calls_v2';
/**
 * The channel a message that NAMES the reader is filed on - `CanariApplication.ensureChannels`.
 *
 * IT IS THE USER'S OWN SWITCH, WHICH IS WHY IT CANNOT BE LEFT TO ONE TRANSPORT. Android gives every
 * channel its own importance, sound, vibration and Do-Not-Disturb standing, and it gives the user a
 * toggle per channel: `canari_mentions` exists so that someone who mutes the chatter still hears
 * their own name, and it is the only channel besides calls for which the app requests DND override.
 *
 * Until this constant existed the web half had no mentions branch at all and passed
 * {@link CHANNEL_MESSAGES} for everything, while `CanariFirebaseMessagingService` read the decrypted
 * text for `@[myUserId]` and filed it correctly. Since the builder follows the message's ROUTE and
 * not the app's state, one mention was filed under the reader's mute settings and the next was not,
 * decided by nothing the reader can see. Measured as NOTIF-16 on 2026-09-08: a mention over the
 * WebSocket landed on `canari_messages`, the same mention pushed landed on `canari_mentions`.
 */
export const CHANNEL_MENTIONS = 'canari_mentions_v2';
/**
 * The channel a REACTION to one of this account's messages is filed on (`canari_reactions_v2`,
 * IMPORTANCE_DEFAULT: a sound and a shade entry, no heads-up). Named by the plain path below for
 * completeness only: on Android a reaction is posted by the native builder, never by the plugin.
 */
export const CHANNEL_REACTIONS = 'canari_reactions_v2';

export function useNotifications() {
  let lastNotificationAt = $state(0);
  let lastSendToneAt = $state(0);
  let lastReadToneAt = $state(0);
  // Per-conversation rate limit: conversationId → last notification timestamp.
  // Prevents notification spam on burst but lets different conversations notify independently.
  const lastNotifAtByConv = new SvelteMap<string, number>();
  /**
   * Notification id -> the conversation it was posted for, so a tap can be routed by the only
   * value that crosses the OS boundary.
   *
   * The table exists because the LISTENER IS REGISTERED ONCE and therefore cannot close over one
   * conversation. It used to be registered inside the post itself, which added a listener per
   * notification: every one of them survived, every one of them fired on every tap, and after ten
   * messages a single tap printed the diagnostic below ten times. A leak and a noise multiplier
   * from the same line.
   *
   * Unbounded is fine and bounded would be wrong: one entry per conversation this session has
   * notified about, overwritten in place because the id is a pure function of the conversation.
   */
  const notifTargetsById = new SvelteMap<number, string>();
  let notifTapListenerArmed = false;
  let notifIdentityMissingAnnounced = false;

  /**
   * Registers the ONE notification-tap listener this session will have, the first time a
   * notification is posted with a conversation attached.
   *
   * **THIS CANNOT WORK ON ANDROID TODAY AND THE PLATFORM IS WHY** - measured on a Mi 9T on
   * 2026-09-07 with a real message, which opened the app and landed on nothing, and confirmed
   * against `tauri-plugin-notification` 2.3.3 on 2026-09-08. The tap payload is exactly
   * `{inputValue, actionId, notification}`. `notification` is parsed from the intent extra
   * `sourceJson`, which `Notification.kt` declares as `var sourceJson: String? = null` and the
   * plugin assigns NOWHERE. The notification id IS on the intent
   * (`TauriNotificationManager.kt:300`) but `handleNotificationActionPerformed` reads it only to
   * dismiss the notification and never puts it in the payload, and `extra` never reaches the intent
   * at all. **There is no field to read**, so no amount of TypeScript here routes an Android tap.
   *
   * Kept, and written to route correctly the moment a payload does carry an id, because desktop is
   * a different implementation (`desktop.rs`, notify-rust) that has not been measured - deleting
   * this would trade a known-broken path for an unmeasured claim about another one.
   *
   * The durable answer is for ONE builder to post every notification natively: the Kotlin path
   * already posts `ACTION_VIEW fr.emse.canari://chat/<groupId>`, a deep link the app handles. It is
   * filed as a native work package; see `docs/wiki/backlog.md`.
   */
  function armNotificationTapListener() {
    if (notifTapListenerArmed) return;
    // Latched before the attempt, not after it: ONE attempt per session whatever the outcome, and
    // one line about it. Both failure branches below were silent, which made "this platform cannot
    // observe a tap" and "the code never got here" the same observation from outside.
    notifTapListenerArmed = true;
    // The registration's every outcome is `armPageTapListener`'s: only a RESOLVED one arms the
    // resume's hold on a page notification (`resumeOpening.svelte.ts`).
    armPageTapListener(
      typeof onAction === 'function' ? (onAction as unknown as RegisterPageTap) : undefined,
      async (action) => {
        // PUBLISHING THE TARGET IS ALL A TAP DOES: the landing effect in `ChatBackgroundService`
        // routes and selects. A `goto` here, on a layout where the conversation is an overlay (a
        // phone, or a narrow window), drained the overlay the landing had just opened
        // (`shareLanding.ts`, 2026-10-27). A tap routed nowhere says so to the resume's hold.
        const outcome = routePageNotificationTap(action, notifTargetsById, (target) => {
          console.log(`[NOTIF] Tap on ${target}: landing published`);
          notifNav.navigate(target);
        });
        if (outcome === 'no-identity') {
          // ANNOUNCED ONCE PER SESSION. The cause is a property of the platform, not of the tap,
          // so repeating it per tap says nothing new and buries what does.
          if (!notifIdentityMissingAnnounced) {
            notifIdentityMissingAnnounced = true;
            console.warn(
              '[NOTIF] A notification tap arrived carrying no notification identity, so it cannot ' +
                'be routed to a conversation. This is tauri-plugin-notification never populating ' +
                'sourceJson; the notification must be posted natively instead. Opening nothing, ' +
                'and this is said once per session.'
            );
          }
          return;
        }
        if (outcome === 'not-ours') {
          console.warn(
            `[NOTIF] Tap on notification ${action?.notification?.id}, which this session did not post.`
          );
        }
      }
    );
  }
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
  /** Active incoming-call OS notification, kept so it can be dismissed on answer/hangup. */
  let incomingCallNotification: Notification | null = null;
  /** Tauri notification id of the active incoming-call notification, for cancellation. */
  let incomingCallNotifId: number | null = null;
  /**
   * The reaction notifications THIS PAGE raised through the plugin or the browser (iOS, desktop,
   * web), per conversation, so opening the conversation takes them down - "the reaction's alert goes
   * with its conversation" ({@link dismissConversationReactions}). Android's are the native
   * builder's, cancelled there. A push-drawn one is not here: the page never held it.
   */
  type RaisedReaction = { key: string; id?: number; notification?: Notification };
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a registry of handles read only by imperative dismissals, nothing renders from it
  const raisedReactions = new Map<string, RaisedReaction[]>();

  // ---------- Audio ----------

  // The output itself - opened for a tone, suspended when the last one ends, closed when the app
  // leaves the screen - is `toneOutput`'s; every tone below only schedules its oscillators.

  /**
   * Plays the "message" trill (palette A) when an incoming message arrives, rate-limited to one every
   * 600 ms. A mention has its own sound and shares this limit, so a burst never stacks the two.
   */
  function playNotificationTone(sound: 'message' | 'mention' = 'message') {
    if (typeof window === 'undefined') return;
    if (!settings.soundsEnabled) return;
    const now = Date.now();
    if (now - lastNotificationAt < 600) return;
    lastNotificationAt = now;

    playTone(sound, (ctx, startAt) => scoreSound(sound, ctx, startAt));
  }

  /** Plays the "send" trill (palette A) when the user sends a message (rate-limited to one every 200 ms). */
  function playSendTone() {
    if (typeof window === 'undefined') return;
    if (!settings.soundsEnabled) return;
    const now = Date.now();
    if (now - lastSendToneAt < 200) return;
    lastSendToneAt = now;

    playTone('send', (ctx, startAt) => scoreSound('send', ctx, startAt));
  }

  /** Plays the received-message trill: the "mention" one when the message names the reader. */
  function playReceiveTone(mentionsMe = false) {
    playNotificationTone(mentionsMe ? 'mention' : 'message');
  }

  /**
   * Rings the incoming call - Canari's own ring, looped until {@link stopIncomingCallRingtone}
   * (`utils/callRing.ts`: natively on Android, on the tone output elsewhere). The conversation, the
   * caller and the video flag are what Android's native ring posts if the app leaves the screen.
   */
  function startIncomingCallRingtone(call: {
    callId: string;
    groupId: string;
    callerId: string;
    hasVideo: boolean;
  }) {
    startCallRing({ ...call, appSounds: settings.soundsEnabled });
  }

  /**
   * Stops the incoming-call ring. A NO-OP when nothing rings: its caller is an `$effect` that runs on
   * every call-state evaluation, at startup with no call in sight.
   */
  function stopIncomingCallRingtone(reason: string) {
    stopCallRing(reason);
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
   * The ring waiting for the app to leave the screen, and the listener that posts it then.
   * Cleared by `dismissIncomingCall` (answered, declined, ended), so a ring that is over never posts.
   */
  let deferredCallNotice: { callerName: string; groupId: string } | null = null;
  let deferredCallNoticeListener: (() => void) | null = null;

  function clearDeferredCallNotice() {
    deferredCallNotice = null;
    if (deferredCallNoticeListener) {
      document.removeEventListener('visibilitychange', deferredCallNoticeListener);
      deferredCallNoticeListener = null;
    }
  }

  /**
   * Shows an OS notification for an incoming call - ONLY WHILE THE APP IS OFF SCREEN.
   *
   * On screen the ring is already the whole screen (`CallOverlay`, every route) or the top bar under
   * the PIN lock, so an OS banner on top of it says the same thing twice and covers the top of the
   * ring (CALL-OS-BANNER, iPhone, 2026-10-19). So a visible page DEFERS the notice: it is posted if
   * the page hides while the call still rings, and dropped when the ring ends.
   * Not rate-limited (unlike message notifications). Tap opens the conversation in /chat.
   */
  async function notifyIncomingCall(callerName: string, groupId: string) {
    if (typeof window === 'undefined') return;

    if (document.visibilityState === 'visible') {
      appendLog(
        `[NOTIF] incoming call in ${groupId} rings in-app - no OS notification while the app is on screen`
      );
      clearDeferredCallNotice();
      deferredCallNotice = { callerName, groupId };
      deferredCallNoticeListener = () => {
        if (document.visibilityState !== 'hidden' || !deferredCallNotice) return;
        const pending = deferredCallNotice;
        clearDeferredCallNotice();
        appendLog(
          `[NOTIF] the app left the screen while ${pending.groupId} rings - posting the OS notification`
        );
        void notifyIncomingCall(pending.callerName, pending.groupId);
      };
      document.addEventListener('visibilitychange', deferredCallNoticeListener);
      return;
    }

    const title = m.call_incoming_label();
    const body = callerName
      ? m.notif_call_body_named({ caller: callerName })
      : m.notif_call_body_unknown();
    const notifId = stableNotifId(`call:${groupId}`);

    // Publishing the target is all a tap does - the landing effect routes (see the tap listener).
    const onTap = () => {
      notifNav.navigate(groupId);
      try {
        window.focus();
      } catch (e) {
        appendLog(`[NOTIF] incoming-call tap: the window could not take the focus (${String(e)})`);
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
      } catch (e) {
        // The native notification of a ringing call was refused: the web Notification below is
        // what is left, and reaching it is a defect of the native path, said at error level.
        console.error(`[NOTIF] the native incoming-call notification of ${groupId} failed:`, e);
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
          onTap();
          n.close();
          incomingCallNotification = null;
        };
        n.onclose = () => {
          if (incomingCallNotification === n) incomingCallNotification = null;
        };
      } catch (e) {
        // A browser that refuses the constructor (Chrome on Android wants a service worker): the
        // ring still shows in the page, but the OS says nothing - said, never swallowed.
        console.warn(`[NOTIF] the incoming-call notification of ${groupId} was refused:`, e);
      }
    }
  }

  /** Dismisses the incoming-call OS notification (call answered, declined, or ended). */
  async function dismissIncomingCall() {
    clearDeferredCallNotice();
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

  /** Plays the "read" trill (palette A) when messages are marked as read (rate-limited to one every 250 ms). */
  function playReadTone() {
    if (typeof window === 'undefined') return;
    if (!settings.soundsEnabled) return;
    const now = Date.now();
    if (now - lastReadToneAt < 250) return;
    lastReadToneAt = now;

    playTone('read', (ctx, startAt) => scoreSound('read', ctx, startAt));
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
  /**
   * THE PREAMBLE EVERY SYSTEM NOTIFICATION SHARES - a message's and a reaction's - so neither can
   * drift from the other's refusal or throttle. Whether one may be raised now under `convKey` (the
   * conversation for a message, `reaction:<message>:<reactor>:<at>` - ONE reaction - for a reaction);
   * when it may, the throttle window is taken. A reaction's key is new per reaction, so the map gains
   * one entry per reaction raised in the session - deliberately, the price of never swallowing one.
   */
  function mayRaise(convKey: string): boolean {
    if (typeof window === 'undefined') return false;
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
    // the web value says nothing - the Tauri branch of `postPlainNotification` is left as it was.
    if (systemNotificationsBlockedAnnounceOnce()) return false;

    const now = Date.now();
    const lastAt = lastNotifAtByConv.get(convKey) ?? 0;
    if (now - lastAt < 800) {
      // EVERY SWALLOWED BRANCH LOGS. Three returns here were silent, so "the user was not notified"
      // and "the code never got there" were the same observation from outside - which is what made
      // TAB-1's zero unattributable for a day.
      console.log(`[NOTIF] Throttled for ${convKey} - ${now - lastAt} ms since the last (800 ms).`);
      return false;
    }
    lastNotifAtByConv.set(convKey, now);
    return true;
  }

  async function sendSystemNotification(
    title: string,
    body: string,
    conversationId?: string,
    mentionsMe = false,
    /**
     * What the NATIVE builder needs, and only the inbound-message path can supply.
     *
     * On Android this is not decoration: it is the whole call. See `nativeNotification.ts` - the
     * plugin below cannot draw a face, cannot offer a reply, and its tap opens the app onto
     * nothing, so a second builder for the same event is what produced the doubled notification
     * the user reported on 2026-09-18.
     */
    native?: NativeMessageNotification
  ) {
    const convKey = conversationId ?? '__default__';
    if (!mayRaise(convKey)) return;
    // ONE BUILDER ON ANDROID, AND IT IS THE RICH ONE. Checked before the plugin rather than
    // inside it: the plugin path below is the WEB implementation, kept because web and desktop
    // have nothing else, and running it here as well is what posted two notifications for one
    // message. See `nativeNotification.ts` for the pair the user captured.
    if (isAndroidTauriRuntime()) {
      if (!native) {
        // NO SECOND PATH. A call site that reaches Android with nothing for the native builder is
        // a defect in that call site, and saying so is the only way it is ever found - falling
        // back to the plain builder would restore exactly the shape this removed.
        console.log(
          `[NOTIF] Not raised for ${convKey} - Android has one builder and this call gave it nothing to build from.`
        );
        return;
      }
      const accepted = await postNativeMessageNotification(native);
      console.log(
        accepted
          ? `[NOTIF] Raised for ${convKey} by the native builder${mentionsMe ? ` on ${CHANNEL_MENTIONS}` : ''}.`
          : `[NOTIF] Not raised for ${convKey} - the native builder refused it; nothing else posts on Android.`
      );
      return;
    }

    // ONE COMPOSITION FOR EVERY NON-ANDROID BUILDER: a group is titled by its name, never by the
    // sender alone (see `composePlainNotificationText`).
    const shown = composePlainNotificationText(title, body, native);
    await postPlainNotification({
      convKey,
      title: shown.title,
      body: shown.body,
      channelId: mentionsMe ? CHANNEL_MENTIONS : CHANNEL_MESSAGES,
      idKey: conversationId,
      conversationId,
    });
  }

  /**
   * Raises the notification of a REACTION to one of this account's messages - the frame trigger
   * decided by `useMessaging.notifyInboundReaction` (`reactionNotification.ts`): the conversation is
   * off screen, and the push of the same reaction may draw it too.
   *
   * ONE REACTION, ONE NOTIFICATION, WHICHEVER TRIGGER LANDS SECOND. Android asks the native builder,
   * which stamps the line with the reaction's own instant exactly as the push does, so the second is
   * recognised (`alreadyPosted`, the alerted ledger). iOS, desktop and the browser post a plain one
   * whose id is {@link reactionCollapseKey}'s, one per reactor and message - on iOS the push's
   * `apns-collapse-id` is that same
   * decimal, so the system replaces one by the other. It never replaces the conversation's message
   * notification. Throttled per that reaction, so a burst of different reactions loses none.
   */
  async function sendReactionNotification(reaction: NativeReactionNotification) {
    const reactionKey = reactionCollapseKey(reaction.messageId, reaction.actorId);
    // Throttled per REACTION (its instant included), never per slot: a reactor's quick second emoji
    // is a new reaction, and it must replace the first rather than be swallowed by the window.
    if (!mayRaise(`${reactionKey}:${reaction.at}`)) return;
    if (isAndroidTauriRuntime()) {
      const accepted = await postNativeReactionNotification(reaction);
      const shade = reactionNotificationKey(reaction.conversationId);
      console.log(
        accepted
          ? `[NOTIF] Raised for ${shade} by the native builder on ${CHANNEL_REACTIONS}.`
          : `[NOTIF] Not raised for ${shade} - the native builder refused it; nothing else posts on Android.`
      );
      return;
    }
    await postPlainNotification({
      convKey: reactionKey,
      title: reaction.actorName,
      body: m.notif_reaction_message_body({ emoji: reaction.emoji }),
      channelId: CHANNEL_REACTIONS,
      idKey: reactionKey,
      conversationId: reaction.conversationId,
    });
  }

  /** Forgets one held entry (its notification closed by itself), dropping an emptied conversation. */
  function releaseRaisedReaction(conversationId: string, entry: RaisedReaction) {
    const list = raisedReactions.get(conversationId);
    if (!list) return;
    const left = list.filter((r) => r !== entry);
    if (left.length === 0) raisedReactions.delete(conversationId);
    else raisedReactions.set(conversationId, left);
  }

  /**
   * Takes down the reaction notifications this page raised for `conversationId` - the reader opened
   * it, and the bubble now carries what the alert announced. Off Android only (see
   * `raisedReactions`); idempotent, a notification already gone costs nothing.
   *
   * @returns how many were asked to go.
   */
  async function dismissConversationReactions(conversationId: string): Promise<number> {
    const held = raisedReactions.get(conversationId);
    if (!held) return 0;
    raisedReactions.delete(conversationId);
    const ids: { id: number }[] = [];
    for (const r of held) {
      if (r.id !== undefined) ids.push({ id: r.id });
      try {
        r.notification?.close();
      } catch (e) {
        console.warn(`[NOTIF] closing a reaction notification of ${conversationId} failed:`, e);
      }
    }
    if (ids.length > 0) {
      try {
        await removeActive(ids);
      } catch (e) {
        console.warn(`[NOTIF] removing the reaction notifications of ${conversationId} failed:`, e);
      }
    }
    console.log(
      `[NOTIF] ${held.length} reaction notification(s) of ${conversationId} taken down - its reader opened it.`
    );
    return held.length;
  }

  /** Remembers a reaction notification the page raised, for {@link dismissConversationReactions}. */
  function holdRaisedReaction(
    channelId: string,
    conversationId: string | undefined,
    entry: RaisedReaction
  ): RaisedReaction | null {
    if (channelId !== CHANNEL_REACTIONS || !conversationId) return null;
    // One entry per slot: a reactor's second reaction to one message REPLACES the first (same id or
    // tag), so holding both would only duplicate it.
    const list = (raisedReactions.get(conversationId) ?? []).filter((r) => r.key !== entry.key);
    list.push(entry);
    raisedReactions.set(conversationId, list);
    return entry;
  }

  /**
   * THE PLAIN BUILDERS - the plugin (iOS, desktop) and the browser's Notification API - shared by a
   * message and a reaction, so neither can drift from the other's permission, tap and sound rules.
   *
   * @param p.idKey what the notification's id (plugin) or tag (browser) is derived from: the
   *   conversation for a message (a second message updates the first), the reactor and the message
   *   for a reaction (`reactionCollapseKey`, the push's own collapse id on iOS: a reactor's second
   *   reaction to one message replaces the first) - so the two kinds never replace each other.
   * @param p.conversationId where a tap leads.
   */
  async function postPlainNotification(p: {
    convKey: string;
    title: string;
    body: string;
    channelId: string;
    idKey?: string;
    conversationId?: string;
  }) {
    const { convKey, title, body, channelId, idKey, conversationId } = p;
    if (isTauriRuntime()) {
      try {
        if (await isPermissionGranted()) {
          await sendNotification({
            title,
            ...androidNotificationOptions(body, channelId),
            ...(idKey ? { id: stableNotifId(idKey) } : {}),
          });
          // The plugin reports no close, so a plugin entry lives until its conversation is opened -
          // one small id per reactor and message at most (`holdRaisedReaction` dedupes by slot).
          if (idKey) {
            holdRaisedReaction(channelId, conversationId, {
              key: idKey,
              id: stableNotifId(idKey),
            });
          }
          // THE CHOICE IS LOGGED BECAUSE IT IS INVISIBLE OTHERWISE. A channel does not appear on
          // the notification; it decides which of the reader's own switches apply to it, and the
          // only place it can be read back is `dumpsys notification`, with the phone in hand.
          if (channelId === CHANNEL_MENTIONS) {
            console.log(`[NOTIF] Filed on ${CHANNEL_MENTIONS} - it names this user.`);
          }
          // TAPPING THIS NOTIFICATION CANNOT REACH THE CONVERSATION, AND THE PLUGIN IS WHY -
          // measured on a Mi 9T on 2026-09-07 with a real message, which opened the app and landed
          // on nothing.
          //
          // ANDROID NO LONGER REACHES HERE: the branch above asks the native builder instead, which
          // is the answer the last paragraph of this comment filed. What is left below is WEB and
          // DESKTOP, where the plugin is the only builder there is - and desktop is a different
          // implementation again (`desktop.rs`, notify-rust) that no session has measured.
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
          // THE FIX WAS NOT HERE, AND IT SHIPPED ON 2026-09-18. The Kotlin path carries identity
          // properly - its tap is `ACTION_VIEW` on `fr.emse.canari://chat/<groupId>`, a deep link
          // the app already handles - and the plugin hardcodes `ACTION_MAIN` on the launcher
          // activity with no way to pass a link. So ONE builder posts every message notification
          // natively and this call site asks it: `notify_native_message`, and
          // `nativeNotification.ts` for the pair of notifications that removed.
          if (idKey && conversationId) {
            notifTargetsById.set(stableNotifId(idKey), conversationId);
            armNotificationTapListener();
          }
        }
        return;
      } catch (e) {
        // NO FALLBACK TO THE BROWSER'S API: this is a Tauri runtime, where the plugin is the one
        // builder (Android's is the native one, asked above), and the WebView's `Notification` would
        // raise a SECOND, differently-identified system notification for the same event. The plugin
        // throws only when its native side is unavailable or refuses (a missing permission is a
        // `false` answer, handled above), which is a defect to see, not a path to route around.
        console.error(
          `[NOTIF] The notification plugin threw for ${convKey} (${e instanceof Error ? e.name : typeof e}) - nothing was raised: ${String(e)}`
        );
        return;
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
        // A call holds the sound (`callSoundGate`): the banner is still raised, only without its
        // sound - the message arrives, the call is not interrupted by it.
        const silent = callHoldsAppSound();
        if (silent) console.log(`[NOTIF] ${convKey} raised silent - a call holds the app's sound.`);
        const n = new Notification(title, {
          body,
          tag: `canari-${idKey ?? 'message'}`,
          silent,
        });
        n.onclick = () => {
          try {
            window.focus();
          } catch {
            /* ignore */
          }
          // Publishing the target is all a click does - the landing effect routes (see the tap
          // listener).
          if (conversationId) notifNav.navigate(conversationId);
          n.close();
        };
        const held = holdRaisedReaction(channelId, conversationId, {
          key: idKey ?? convKey,
          notification: n,
        });
        // A notification that closed - by itself after 8 s, by a click, by the user - is no longer
        // held: only an open one can be taken down with its conversation.
        const release = () => {
          if (held && conversationId) releaseRaisedReaction(conversationId, held);
        };
        n.onclose = release;
        console.log(`[NOTIF] Raised for ${convKey}.`);
        setTimeout(() => {
          n.close();
          release();
        }, 8000);
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
    sendReactionNotification,
    dismissConversationReactions,
    startIncomingCallRingtone,
    stopIncomingCallRingtone,
    startBlinkingTitle,
    stopBlinkingTitle,
    notifyIncomingCall,
    dismissIncomingCall,
  };
}
