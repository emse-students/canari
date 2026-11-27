import { untrack } from 'svelte';
import { serverMailMode } from '$lib/stores/appVersionCheck.svelte';
import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
import { currentUserId } from '$lib/stores/userState.svelte';
import { gatewayUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';
import { mailStreamOpener, platformTransport } from './connect';
import { MailApi } from './mailApi';
import { classifyMailFailure } from './mailErrors';
import { canariMailContext } from './mailContext';
import { MailSession, type MailContext, type MailSoap } from './mailSession';
import { registerMailSignOut } from './mailSignOut';
import { MailStore } from './mailStore.svelte';
import { ZimbraSoapClient } from './soapClient';

/**
 * THE MAIL CLIENT OF THE SIGNED-IN CANARI ACCOUNT, AND WHETHER ITS TAB IS SHOWN
 * (docs/wiki/mail-client-transport.md#as-built---lot-3; D10, D12).
 *
 * ONE {@link MailClient} per Canari account: the session, the API over it and the store the screens
 * read. It is built for the account signed in and REPLACED when that account changes - the previous
 * mailbox signed out first - so a mailbox is never shown under another Canari account's name. The
 * Canari sign-out ends it through `mailSignOut.ts`.
 *
 * THE TAB (D10) IS SHOWN WHEN TWO FACTS AGREE: the server's switch `mail_mode` is `on` (D12, read from
 * `/api/version`, off by default) and the account's own address is on an eligible domain (D1). Before
 * either is known the tab is hidden - never shown and then withdrawn.
 */

/** The session, the API and the store of one Canari account's mailbox. */
export class MailClient {
  readonly userId: string;
  readonly session: MailSession;
  readonly api: MailApi;
  readonly store: MailStore;

  /** Whether {@link readEligibility} has answered once: before that the tab is not drawn at all. */
  eligibilityRead = $state(false);

  constructor(
    soap: MailSoap,
    private readonly context: MailContext,
    storage: Storage = localStorage
  ) {
    this.userId = context.userId;
    this.session = new MailSession(soap, context, storage);
    this.api = new MailApi(this.session);
    this.store = new MailStore(this.api, this.session);
  }

  /**
   * Reads D1 from the account's own address (`MailStore.loadEligibility`) and marks it read. Before
   * this answers, the tab is neither shown nor withdrawn - it is simply not drawn yet.
   */
  async readEligibility(): Promise<void> {
    await this.store.loadEligibility();
    this.eligibilityRead = true;
  }

  /**
   * Whether the account has no school address on this device yet: an existing account gets it only
   * at its next full MiConnect sign-in (the `school_mail` claim, lot 1), so this is the ordinary
   * state before that - the screen offers "Activer le mail", never an error.
   */
  needsActivation(): boolean {
    return this.eligibilityRead && this.store.eligibility === 'unknown';
  }

  /** The account's own school address, as the sign-in screen shows it (`null`: not handed yet). */
  ownAddress(): Promise<string | null> {
    return this.context.mailAddress();
  }

  /**
   * Opens the mailbox from the remembered password when there is one, then loads the folder tree
   * (the inbox badge). Nothing remembered leaves the session signed out, quietly: the sign-in
   * screen asks when the tab is opened. Never throws - a failure is the store's to show.
   */
  async warmUp(): Promise<void> {
    Log.d('MAIL', 'warm up');
    try {
      if (await this.session.resume()) await this.store.refreshFolders();
    } catch (err) {
      const failure = classifyMailFailure(err);
      this.store.error = failure;
      Log.w('MAIL', `the mailbox did not open from the remembered password (${failure.kind})`);
    }
  }

  /** Signs the mailbox out and stops the store following it. */
  async end(reason: string): Promise<void> {
    Log.d('MAIL', `mail client ended (${reason})`);
    this.store.dispose();
    await this.session.signOut();
  }
}

/** The production client of `userId`: the platform's transport (D4), TLS in the client (D3). */
function buildClient(userId: string): MailClient {
  const soap = new ZimbraSoapClient(mailStreamOpener(platformTransport(gatewayUrl())));
  return new MailClient(
    soap,
    canariMailContext(userId, () => globalSession.deviceKeyB64 || null)
  );
}

let current = $state<MailClient | null>(null);
let unregister: (() => void) | null = null;

/** Ends the current client, if any (a Canari sign-out, an account switch). */
async function endCurrent(reason: string): Promise<void> {
  const client = current;
  if (!client) return;
  current = null;
  unregister?.();
  unregister = null;
  await client.end(reason);
}

/**
 * The client of `userId`, built on first use; the client of a previous account is ended first.
 * `build` is the production client unless a caller (the dev preview, a test) hands its own.
 */
export function mailClientFor(
  userId: string,
  build: (userId: string) => MailClient = buildClient
): MailClient {
  if (current?.userId === userId) return current;
  if (current) {
    Log.i('MAIL', 'the canari account changed - the previous mailbox is signed out');
    void endCurrent('account switch');
  }
  const client = build(userId);
  current = client;
  unregister = registerMailSignOut((reason) => endCurrent(reason));
  return client;
}

/** The client of the account signed in now, when one was built. Reactive. */
export function currentMailClient(): MailClient | null {
  return current;
}

/**
 * Whether the Mail tab is shown (D10): the server's switch is on (D12) AND the account's eligibility
 * has been read and is not a refusal (D1) - an eligible address, or no address yet (the screen then
 * offers "Activer le mail", the decided product rule). An address off the school domains hides it.
 * Reactive: a bar that reads it follows both.
 */
export function mailTabVisible(): boolean {
  if (serverMailMode() !== 'on') return false;
  const client = current;
  return (
    client !== null &&
    client.userId === currentUserId() &&
    client.eligibilityRead &&
    client.store.eligibility !== 'not_eligible'
  );
}

/** The inbox's unread count, the tab's badge (D10); 0 while the tab is hidden. Reactive. */
export function mailInboxUnread(): number {
  return mailTabVisible() ? (current?.store.inboxUnread ?? 0) : 0;
}

let watching = false;

/**
 * Starts following the signed-in account and the server's switch, ONCE per document: with the
 * switch on and an account signed in, its client is built, its eligibility read from its own address,
 * and - when eligible - its mailbox opened from a remembered password so the badge has a count. Called
 * by the navigation bars, which are what the tab lives in.
 */
export function watchMailTab(): void {
  if (watching) return;
  watching = true;
  // The new-mail notifications follow the same client (lot 4). Loaded apart: it imports this module.
  void import('./mailWatch.svelte')
    .then((watch) => watch.watchMailNotifications())
    .catch((err: unknown) =>
      Log.w('MAIL', `ERROR: the new-mail watch could not be loaded (${String(err)})`)
    );
  $effect.root(() => {
    $effect(() => {
      const userId = currentUserId();
      const on = serverMailMode() === 'on';
      // Only the account and the switch are this effect's dependencies: what the client reads and
      // writes as it opens is not, or every state change would open it again.
      untrack(() => followMailSwitch(userId, on));
    });
  });
}

/**
 * One step of {@link watchMailTab}, for the account signed in now and the server's switch. The
 * switch turned OFF ends a client already built (review M5): its session signed out, its socket
 * closed - "off, nothing of the mail runs" holds for a client opened while it was on, not only for
 * one not yet built. On, with an account, that account's client is opened for the tab.
 */
export function followMailSwitch(
  userId: string | null,
  on: boolean,
  build: (userId: string) => MailClient = buildClient
): void {
  if (!on) {
    if (current) {
      Log.i('MAIL', 'the mail switch is off - the open mailbox is ended');
      void endCurrent('mail switched off');
    }
    return;
  }
  if (!userId) return;
  openTabOf(userId, build);
}

/** Builds `userId`'s client, reads its eligibility, and opens an eligible mailbox for the badge. */
function openTabOf(userId: string, build: (userId: string) => MailClient): void {
  const client = mailClientFor(userId, build);
  void (async () => {
    await client.readEligibility();
    const eligibility = client.store.eligibility;
    if (eligibility === 'not_eligible') {
      Log.d('MAIL', 'the mail tab stays hidden (not an eligible address)');
      return;
    }
    if (eligibility === 'unknown') {
      Log.i('MAIL', 'the mail tab is shown to activate (no school address on this device yet)');
      return;
    }
    Log.d('MAIL', 'the mail tab is shown');
    if (client.session.state.kind === 'signed_out') await client.warmUp();
  })();
}
