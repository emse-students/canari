import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import {
  NATIVE_MAIL_EVENT,
  announceAndroidPageReplaced,
  armAndroidMailWatch,
  claimAndroidMailWatch,
  releaseAndroidMailWatch,
  startAndroidMailService,
  stopAndroidMailService,
} from '$lib/mobile/androidMailWatch';
import { m } from '$lib/paraglide/messages';
import {
  serverMailMode,
  serverMailModeKnown,
  serverMailPush,
} from '$lib/stores/appVersionCheck.svelte';
import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { apiFetch } from '$lib/utils/apiFetch';
import { deliveryUrl } from '$lib/utils/apiUrl';
import { isAppOnScreen, onAppScreenChange } from '$lib/utils/appForeground';
import { isAndroidTauriRuntime, isIosTauriRuntime } from '$lib/utils/appVersion';
import { appPathFromPathname } from '$lib/utils/internalPath';
import { Log } from '$lib/utils/Log';
import { gatewayUrl } from '$lib/utils/apiUrl';
import { httpMailAlertServer, syncMailAlert, type MailAlertOutcome } from './mailAlert';
import { createMailAlertSync } from './mailAlertSync';
import { eraseMailPushSecret, storeMailPushSecret } from './mailPushSecret';
import { mailStreamOpener, platformTransport } from './connect';
import { currentMailClient, type MailClient } from './mailClient.svelte';
import { postMailNotices } from './mailNotify';
import type { MailSessionState } from './mailSession';
import { MailWatcher, type CheckOutcome, type NewMail } from './mailWatcher';
import {
  eraseNativeMailPassword,
  platformCursorStore,
  type MailCursorStore,
} from './mailWatchCursor';
import {
  forgetMailNotificationsSwitch,
  mailNotificationsWanted,
  mailPersistentWanted,
  setMailNotificationsWanted,
} from './mailWatchSwitch.svelte';
import { readRememberedMailPassword } from './sealedMailPassword';
import { ZimbraSoapClient } from './soapClient';

/**
 * WHEN THE NEW-MAIL WATCHER RUNS, ON EACH PLATFORM (docs/wiki/mail-client-transport.md#as-built---lot-4).
 *
 * It runs while FOUR facts agree, every one of them read, never timed: the server's `mail_mode` is
 * `on` (D12), the account's address is eligible (D1), its mailbox is open (`ready`), and the account
 * turned "Notifications de nouveaux mails" on for this device (off by default). Any of them turning
 * false stops it - a mail sign-out, a Canari sign-out, a closed account (D8), the switch off, the
 * server's switch off - and a run that ends BY ITSELF (the mailbox refused it) says so, so what was
 * held for it (the Web Lock, the Android service) is released at once.
 *
 * - **Android**: the same, plus `MailWatchService` holding the foreground while it runs, so the
 *   watch survives the app leaving the screen (the persistent connection of D11). A stop is ALWAYS
 *   sent when the watch should not run, and on a `started` for a page the page did not ask for.
 *   **With no page, the NATIVE watcher (lot 4b)**: while the switch is on AND the password is
 *   remembered, the page ARMS a Keystore-sealed copy of it (`arm`); when the page goes (a new
 *   document says so with `page`), at boot and after the process is killed, the service runs the
 *   native watcher from that copy. The page CLAIMS the watch before its own run starts (`claim`,
 *   answered once the native run is joined), so one watcher runs at a time over the one cursor. A
 *   fact READ false (the switch, the server, the mailbox ended, the password not remembered) erases
 *   the copy (`eraseNativeMailPassword`).
 * - **iOS**: in the foreground it runs as anywhere; in the background iOS freezes the app, and the
 *   system's background refresh (`canari_ios.mm`, `BGAppRefreshTask`) asks the page for ONE check,
 *   when the system allows - best effort, no promise of immediacy (owner, 2026-11-27). The system is
 *   told whether to ask through ONE flag file the native side reads (`mail_watch_flag`), written only
 *   from READ facts: an unknown server answer or a client not built yet leaves it as it is.
 * - **Web and desktop**: while the app is open; nothing when it is closed. On the web ONE tab
 *   watches (a Web Lock per account), so two tabs never notify one mail twice.
 *
 * The switch turned off ERASES the cursor once the watcher has stopped: turned on again, the watcher
 * takes a new baseline and announces nothing of the time it was off.
 *
 * **Mail lot 5** (`mail_push`, the admin's switch): with `cloudflare`, a PHONE that wants
 * notifications also adds ONE filter rule to the account that notifies Canari (`mailAlert.ts`), so an empty
 * push wakes it in seconds; on Android the persistent connection then runs only if the account ALSO
 * keeps it ("Connexion permanente"). With `none`, nothing changes from lot 4, and Canari's rule,
 * if any, is removed. Web and desktop never subscribe (no push reaches them for mail).
 */

/** The DOM hook the iOS background refresh calls (`canari_ios.mm`). */
const IOS_REFRESH_HOOK = '__canariMailRefresh';
/** Set, and the event below dispatched, once the hook's facts are READ - what the native side awaits. */
const IOS_REFRESH_READY = '__canariMailRefreshReady';
/** The event `canari_ios.mm`'s script awaits on a cold background launch. */
export const IOS_REFRESH_READY_EVENT = 'canari:mail-refresh-ready';

/** What the background refresh is answered: the check's outcome, or `off` when it should not run. */
export type BackgroundRefreshAnswer = CheckOutcome | 'off';

/** The facts the run depends on, read reactively. */
export interface WatchFacts {
  client: MailClient | null;
  mailOn: boolean;
  /** Whether {@link mailOn} is a READ answer of the server rather than its default. */
  mailKnown: boolean;
  wanted: boolean;
  state: MailSessionState['kind'];
  eligible: boolean;
  /** Whether the open mailbox's password is remembered ("remember" ticked): `false` unless `ready`. */
  remembered: boolean;
  /** The server's `mail_push` (lot 5), `none` until read. */
  pushMode: 'none' | 'cloudflare';
  /** Whether {@link pushMode} is a READ answer of the server rather than its default. */
  pushKnown: boolean;
  /** This runtime is a phone (Android or iOS), the only one a mail push reaches. */
  phone: boolean;
  /**
   * Android with `mail_push = cloudflare`: the persistent connection runs only if {@link persistent}
   * says the account keeps it beside the fast path.
   */
  needsPersistent: boolean;
  /** The account's "Connexion permanente" on this device (read only while {@link needsPersistent}). */
  persistent: boolean;
}

/** Whether the watcher runs under `facts`. Pure, for the test of the lifecycle. */
export function watcherShouldRun(facts: WatchFacts): boolean {
  return (
    facts.client !== null &&
    facts.mailOn &&
    facts.wanted &&
    facts.eligible &&
    facts.state === 'ready' &&
    (!facts.needsPersistent || facts.persistent)
  );
}

/**
 * Whether this device wants the EMPTY mail push of lot 5: a phone, the server's `mail_push` READ as
 * `cloudflare`, the Mail tab's switch on, an eligible account, and its notifications on. Pure.
 */
export function mailAlertWanted(facts: WatchFacts): boolean {
  return (
    facts.client !== null &&
    facts.phone &&
    facts.mailOn &&
    facts.pushKnown &&
    facts.pushMode === 'cloudflare' &&
    facts.wanted &&
    facts.eligible
  );
}

/**
 * Whether the system should keep asking for background checks (iOS), or `null` to LEAVE THE FLAG AS
 * IT IS. Only READ facts change it: the server's answer once it arrived, the account's switch once
 * its client exists, and a mailbox that ENDED (signed out or closed). A launch that has not read
 * them yet - no client, no server answer, a mailbox not yet resumed - is not a reason to stop asking.
 */
export function backgroundRefreshWanted(
  facts: WatchFacts,
  previous: MailSessionState['kind'] | null
): boolean | null {
  if (facts.mailKnown && !facts.mailOn) return false;
  if (!facts.client) return null;
  if (!facts.wanted) return false;
  if (facts.state === 'closed') return false;
  if (facts.state === 'signed_out')
    return previous !== null && previous !== 'signed_out' ? false : null;
  return facts.mailKnown ? true : null;
}

/**
 * Whether Android's native watcher should hold a sealed copy of the password (lot 4b): the iOS flag's
 * rule ({@link backgroundRefreshWanted}: only READ facts decide, an unknown one leaves it), plus the
 * user's own "remember" - an open mailbox whose password is not remembered is a fact read false.
 */
export function nativeWatchWanted(
  facts: WatchFacts,
  previous: MailSessionState['kind'] | null
): boolean | null {
  const wanted = backgroundRefreshWanted(facts, previous);
  if (wanted === true && facts.state === 'ready' && !facts.remembered) return false;
  return wanted;
}

/** Whether the reader is looking at the Mail tab now: a new mail is then seen landing, not notified. */
export function mailTabOnScreen(): boolean {
  if (typeof window === 'undefined' || !isAppOnScreen()) return false;
  const path = appPathFromPathname(window.location.pathname);
  return path === '/mail' || path.startsWith('/mail/');
}

/** Posts `fresh`, unless the Mail tab is on screen (the list shows the mail as it lands). */
async function notifyUnlessOnScreen(fresh: NewMail[]): Promise<void> {
  if (mailTabOnScreen()) {
    Log.i('MAIL-WATCH', `${fresh.length} new mail(s) - the Mail tab is on screen, nothing posted`);
    return;
  }
  await postMailNotices(fresh);
}

/** One watcher per mail client, built on first use. */
const watchers = new WeakMap<MailClient, MailWatcher>();

/** The run-end listener of the current controller (one per document). */
let runEndedListener: ((client: MailClient, reason: string) => void) | null = null;

/** The watcher of `client`, wired to the platform. */
function watcherOf(client: MailClient): MailWatcher {
  const known = watchers.get(client);
  if (known) return known;
  const watcher = new MailWatcher({
    userId: client.userId,
    session: client.session,
    openWaitChannel: () => new ZimbraSoapClient(mailStreamOpener(platformTransport(gatewayUrl()))),
    notify: notifyUnlessOnScreen,
    pause: pauseUntilRetry,
    onRunEnded: (reason) => runEndedListener?.(client, reason),
  });
  watchers.set(client, watcher);
  return watcher;
}

/**
 * The retry ladder's pause: `ms` at most, ended EARLIER by the events that make a retry worth it now -
 * the network back (`online`) or the app back on screen - and at once by `signal`. The timer bounds
 * the rate only; nothing decides on it.
 */
export function pauseUntilRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveIt) => {
    if (signal.aborted) {
      resolveIt();
      return;
    }
    let offScreen: (() => void) | null = null;
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      if (typeof window !== 'undefined') window.removeEventListener('online', done);
      offScreen?.();
      resolveIt();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', done);
      offScreen = onAppScreenChange((onScreen) => {
        if (onScreen) done();
      });
    }
  });
}

/**
 * Runs `watcher` under the account's Web Lock where the engine has one (the web: one tab watches,
 * the others wait for the lock), or directly.
 */
function runExclusive(userId: string, watcher: MailWatcher, signal: AbortSignal): void {
  if (isAndroidTauriRuntime()) {
    // One watcher at a time over the one cursor: the native run is stopped and JOINED first.
    void claimAndroidMailWatch().then(
      () => {
        if (!signal.aborted) watcher.start();
      },
      (err: unknown) => {
        // Not started: a page run beside a native one would be two writers of one cursor.
        Log.w(
          'MAIL-WATCH',
          `ERROR: the claim was not sent - the page watch does not start (${String(err)})`
        );
      }
    );
    return;
  }
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks || isIosTauriRuntime()) {
    watcher.start();
    return;
  }
  void locks
    .request(`canari-mail-watch-${userId}`, { signal }, async () => {
      if (signal.aborted) return;
      Log.d('MAIL-WATCH', 'this tab holds the watch');
      watcher.start();
      await new Promise<void>((resolveIt) => signal.addEventListener('abort', () => resolveIt()));
    })
    .catch((err: unknown) => {
      if (signal.aborted) return;
      Log.w('MAIL-WATCH', `ERROR: the watch lock was not granted (${String(err)})`);
    });
}

/**
 * Whether the native watch persists - resumed at boot, kept in the foreground service - rather than
 * only answering the mail push's one check: always with `mail_push = none` (lot 4's persistent
 * connection is the only path), and with `cloudflare` only when the account keeps "Connexion
 * permanente" (lot 5). Pure.
 */
export function nativeWatchPersists(
  facts: Pick<WatchFacts, 'needsPersistent' | 'persistent'>
): boolean {
  return !facts.needsPersistent || facts.persistent;
}

/**
 * Arms the native watcher's sealed copy for `client`, unless the decision moved on while the
 * remembered password was read: `stillDecided` (the page's last decision is still this one) and the
 * session's generation (no sign-out, closed account or new sign-in since) are re-read RIGHT BEFORE
 * the arm is sent (review I3 of #4213). The native side orders an arm against a later forget on its
 * own executor. `persistent` ({@link nativeWatchPersists}) travels with the arm, so the boot resume
 * follows the account's choice rather than the copy's existence. `true` when sent.
 */
export async function armNativeCopyIfCurrent(
  client: Pick<MailClient, 'userId' | 'session'>,
  stillDecided: () => boolean,
  persistent: boolean
): Promise<boolean> {
  const generation = client.session.generation;
  const remembered = await client.session.rememberedForNativeWatch();
  if (!remembered) return false;
  if (!stillDecided() || client.session.generation !== generation) {
    Log.d('MAIL-WATCH', 'the native copy decision moved on - this arm is not sent');
    return false;
  }
  return armAndroidMailWatch(client.userId, remembered.account, remembered.password, persistent);
}

/** Writes the iOS flag the background refresh reads. Logged; a failure is said, never thrown. */
async function writeIosFlag(on: boolean): Promise<void> {
  try {
    await invoke('mail_watch_flag', { on });
    Log.i('MAIL-WATCH', `background refresh ${on ? 'asked for' : 'no longer asked for'}`);
  } catch (err) {
    Log.w('MAIL-WATCH', `ERROR: the background refresh flag was not written (${String(err)})`);
  }
}

/**
 * The switch turned OFF: erases the account's cursor once `stopped` (the run's stop) settled, so a
 * run still reading cannot write it back - turned on again, the watch takes a new baseline and
 * announces nothing that came while it was off (I1).
 */
export async function eraseCursorOnceStopped(
  stopped: Promise<void>,
  userId: string,
  store: MailCursorStore = platformCursorStore()
): Promise<void> {
  await stopped;
  await store.erase(userId);
  Log.i('MAIL-WATCH', 'switched off - the cursor is erased');
}

let watching = false;

/**
 * Follows the facts of {@link watcherShouldRun} for the account's mail client, ONCE per document
 * (`watchMailTab` calls it). Idempotent.
 */
export function watchMailNotifications(): void {
  if (watching) return;
  watching = true;
  Log.d('MAIL-WATCH', 'following the new-mail notification facts');
  let running: { client: MailClient; watcher: MailWatcher; lock: AbortController } | null = null;
  /** The client whose run ended by itself: not restarted until one of its facts changes. */
  let endedBy: { client: MailClient; key: string } | null = null;
  let serviceHeld = false;
  let serviceRefusedOffScreen = false;
  let lastIosFlag: boolean | null = null;
  let lastState: { client: MailClient; kind: MailSessionState['kind'] } | null = null;
  let lastWanted: { client: MailClient; wanted: boolean } | null = null;
  let lastFacts: WatchFacts | null = null;
  /** The last native-copy decision acted on, keyed by what it was decided from (lot 4b). */
  let lastNativeKey: string | null = null;

  const factsKey = (facts: WatchFacts) =>
    `${facts.mailOn}|${facts.wanted}|${facts.eligible}|${facts.state}|${facts.needsPersistent}|${facts.persistent}`;
  const alertSync = createMailAlertSync(runAlertSync);

  /** The page's run stopped: the native side may let a push check read again - unless a run took over. */
  const releaseOnceStopped = (stopped: Promise<void>) => {
    void stopped.then(() => {
      if (!running) releaseAndroidMailWatch();
    });
  };

  const holdService = (run: boolean) => {
    if (!isAndroidTauriRuntime()) return;
    if (run && !serviceHeld) {
      serviceHeld = startAndroidMailService({
        title: m.mail_watch_ongoing_title(),
        text: m.mail_watch_ongoing_text(),
      });
    } else if (!run && serviceHeld) {
      serviceHeld = false;
      serviceRefusedOffScreen = false;
      stopAndroidMailService('the watch stopped');
    }
  };

  const apply = (facts: WatchFacts) => {
    lastFacts = facts;
    if (endedBy && (endedBy.client !== facts.client || endedBy.key !== factsKey(facts))) {
      endedBy = null;
    }
    const run = watcherShouldRun(facts) && endedBy === null;
    let stopped: Promise<void> = Promise.resolve();
    if (running && (!run || running.client !== facts.client)) {
      const ending = running;
      running = null;
      ending.lock.abort();
      stopped = ending.watcher.stop(run ? 'another mailbox' : 'a fact turned false');
      if (isAndroidTauriRuntime()) releaseOnceStopped(stopped);
    }
    if (run && !running && facts.client) {
      const watcher = watcherOf(facts.client);
      const lock = new AbortController();
      running = { client: facts.client, watcher, lock };
      runExclusive(facts.client.userId, watcher, lock.signal);
    }
    holdService(running !== null);

    // The switch turned OFF: once the watcher has stopped, its cursor goes (I1) - turned on again,
    // it takes a new baseline.
    if (facts.client) {
      const before = lastWanted && lastWanted.client === facts.client ? lastWanted.wanted : null;
      lastWanted = { client: facts.client, wanted: facts.wanted };
      if (before === true && !facts.wanted) {
        void eraseCursorOnceStopped(stopped, facts.client.userId);
      }
    }

    const previous = lastState && lastState.client === facts.client ? lastState.kind : null;
    lastState = facts.client ? { client: facts.client, kind: facts.state } : null;
    if (facts.state === 'closed' && previous !== 'closed' && facts.client) {
      // D8 erased the switch's key: the value this document read for it goes with it.
      forgetMailNotificationsSwitch(facts.client.userId);
    }
    if (isAndroidTauriRuntime() && facts.client) applyNativeCopy(facts, previous, facts.client);
    if (isIosTauriRuntime()) {
      const flag = backgroundRefreshWanted(facts, previous);
      if (flag !== null && flag !== lastIosFlag) {
        lastIosFlag = flag;
        void writeIosFlag(flag);
      }
      announceIosRefreshReady(facts);
    }
    if (facts.client) {
      alertSync.update({
        userId: facts.client.userId,
        ready: facts.state === 'ready',
        pushKnown: facts.mailKnown && facts.pushKnown,
        want: mailAlertWanted(facts),
      });
    }
  };

  /** Arms or erases the native watcher's sealed copy when what decides it changed (lot 4b). */
  const applyNativeCopy = (
    facts: WatchFacts,
    previous: MailSessionState['kind'] | null,
    client: MailClient
  ) => {
    const want = nativeWatchWanted(facts, previous);
    if (want === null) return;
    const key = `${client.userId}|${want}|${factsKey(facts)}|${facts.remembered}`;
    if (key === lastNativeKey) return;
    lastNativeKey = key;
    if (!want) {
      void eraseNativeMailPassword(client.userId);
      return;
    }
    void armNativeCopyIfCurrent(client, () => lastNativeKey === key, nativeWatchPersists(facts));
  };

  runEndedListener = (client, reason) => {
    if (!running || running.client !== client || !lastFacts) return;
    Log.i('MAIL-WATCH', `the run ended by itself (${reason}) - released until a fact changes`);
    const ended = running;
    running = null;
    ended.lock.abort();
    endedBy = { client, key: factsKey(lastFacts) };
    holdService(false);
    if (isAndroidTauriRuntime()) releaseAndroidMailWatch();
  };

  $effect.root(() => {
    $effect(() => {
      const client = currentMailClient();
      const facts: WatchFacts = {
        client,
        mailOn: serverMailMode() === 'on',
        mailKnown: serverMailModeKnown(),
        wanted: client ? mailNotificationsWanted(client.userId) : false,
        state: client ? client.store.sessionState.kind : 'signed_out',
        eligible: client ? client.store.eligibility === 'eligible' : false,
        remembered:
          client?.store.sessionState.kind === 'ready'
            ? client.store.sessionState.remembered
            : false,
        pushMode: serverMailPush(),
        pushKnown: serverMailModeKnown(),
        phone: isAndroidTauriRuntime() || isIosTauriRuntime(),
        needsPersistent: isAndroidTauriRuntime() && serverMailPush() === 'cloudflare',
        persistent: client ? mailPersistentWanted(client.userId) : false,
      };
      untrack(() => apply(facts));
    });
  });

  if (isAndroidTauriRuntime() && typeof window !== 'undefined') {
    // The document before this one is gone: an armed watch goes native until this page claims it,
    // an unarmed one ends (the native table, `decideMailWatch`).
    announceAndroidPageReplaced();
    window.addEventListener(NATIVE_MAIL_EVENT, (event) => {
      const detail = (event as CustomEvent<{ kind?: string; code?: string }>).detail ?? {};
      Log.i(
        'MAIL-WATCH',
        `service: ${detail.kind ?? 'unreadable'}${detail.code ? ` (${detail.code})` : ''}`
      );
      if (detail.kind === 'started' && detail.code === 'page' && !running) {
        // A page start that raced a stop: the watch it was for is gone, so it goes too. A NATIVE
        // start is the watch with no page (boot, a restart) - this page claims it when it runs.
        serviceHeld = false;
        stopAndroidMailService('started with no watch running');
        return;
      }
      if (detail.kind === 'armed' && detail.code === 'failed') {
        // The copy was not sealed (a forget came first, the storage locked, a write failed): the
        // next apply decides again rather than believing it armed.
        lastNativeKey = null;
        return;
      }
      if (detail.kind === 'failed' || detail.kind === 'stopped') {
        serviceHeld = false;
        serviceRefusedOffScreen = detail.code === 'off-screen';
      }
    });
    // Android refuses a foreground service started from the background: the next return on screen
    // asks again - told by that event, never by a timer.
    onAppScreenChange((onScreen) => {
      if (!onScreen || !serviceRefusedOffScreen || !lastFacts) return;
      serviceRefusedOffScreen = false;
      Log.i('MAIL-WATCH', 'back on screen after an off-screen refusal - asking the service again');
      apply(lastFacts);
    });
  }

  if (isIosTauriRuntime() && typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>)[IOS_REFRESH_HOOK] = () =>
      backgroundRefresh(lastFacts);
  }
}

/**
 * ONE sync of the account's alert for the current client (`mailAlertSync.ts` schedules it), and the
 * iOS extension's copy of the password: written while the push is wanted AND the password is
 * remembered, erased otherwise - one erase, `eraseMailPushSecret`.
 */
async function runAlertSync(userId: string, want: boolean): Promise<MailAlertOutcome> {
  const client = currentMailClient();
  if (!client || client.userId !== userId) {
    Log.d('MAIL-ALERT', 'the client changed before the sync ran - nothing done');
    return 'unchanged';
  }
  const outcome = await syncMailAlert(
    {
      userId,
      deviceId: readDeviceId(userId),
      mailbox: client.session,
      server: httpMailAlertServer((path, body) =>
        apiFetch(`${deliveryUrl()}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ),
      store: localStorage,
      // The user disabled Canari's rule in the webmail: an opt-out, so this device stops asking.
      onOptOut: () => setMailNotificationsWanted(userId, false),
    },
    want
  );
  const subscribed = outcome === 'configured' || outcome === 'joined' || outcome === 'unchanged';
  if (want && subscribed) await writeExtensionSecret(userId);
  else if (!want) await eraseMailPushSecret('the mail push is not wanted');
  return outcome;
}

/** This install's Canari device id for `userId`, or `null` before it exists. */
function readDeviceId(userId: string): string | null {
  try {
    return localStorage.getItem(ACCOUNT_KEY.deviceId(userId));
  } catch (err) {
    Log.w('MAIL-ALERT', `ERROR: the device id could not be read (${String(err)})`);
    return null;
  }
}

/**
 * Writes the iOS extension's copy of the password when the account remembers it (D6), erases it
 * otherwise: without a remembered password the extension shows the generic notice.
 */
async function writeExtensionSecret(userId: string): Promise<void> {
  if (!isIosTauriRuntime()) return;
  const deviceKey = globalSession.deviceKeyB64 || null;
  if (!deviceKey) {
    Log.i('MAIL-ALERT', 'no device key - the extension will show the generic notice');
    await eraseMailPushSecret('no device key');
    return;
  }
  const read = await readRememberedMailPassword(userId, deviceKey);
  if (read.kind !== 'opened') {
    Log.i('MAIL-ALERT', `the password is not remembered (${read.kind}) - the generic notice it is`);
    await eraseMailPushSecret('the password is not remembered');
    return;
  }
  // Re-checked in the write's turn: a forget queued since the read above wins (`mailPushSecret.ts`).
  await storeMailPushSecret(userId, read.remembered.account, read.remembered.password, async () => {
    const again = await readRememberedMailPassword(userId, deviceKey);
    return again.kind === 'opened';
  });
}

/**
 * Tells the native background refresh the hook can answer: once the facts it reads are READ (the
 * server's answer arrived and the account's client exists, or the server said off). Idempotent.
 */
function announceIosRefreshReady(facts: WatchFacts): void {
  if (typeof window === 'undefined') return;
  const decided = (facts.mailKnown && !facts.mailOn) || (facts.mailKnown && facts.client !== null);
  const w = window as unknown as Record<string, unknown>;
  if (!decided || w[IOS_REFRESH_READY] === true) return;
  w[IOS_REFRESH_READY] = true;
  Log.d('MAIL-WATCH', 'background refresh hook ready');
  window.dispatchEvent(new Event(IOS_REFRESH_READY_EVENT));
}

/**
 * ONE check for the iOS background refresh: `off` when the facts say the watch is not wanted; the
 * mailbox is opened from the remembered password if it is not open yet (a launch in the background
 * starts signed out), then the delta is read and notified.
 */
export async function backgroundRefresh(
  facts: WatchFacts | null
): Promise<BackgroundRefreshAnswer> {
  if (!facts?.client || !facts.mailOn || !facts.wanted) {
    Log.i('MAIL-WATCH', 'background refresh: not wanted - nothing read');
    return 'off';
  }
  const { client } = facts;
  if (client.session.state.kind !== 'ready') {
    try {
      if (!(await client.session.resume())) {
        Log.i('MAIL-WATCH', 'background refresh: the mailbox needs its password - nothing read');
        return 'not_ready';
      }
    } catch (err) {
      Log.w('MAIL-WATCH', `background refresh: the mailbox did not open (${String(err)})`);
      return 'not_ready';
    }
  }
  const outcome = await watcherOf(client).checkOnce();
  Log.i('MAIL-WATCH', `background refresh: ${outcome}`);
  return outcome;
}
