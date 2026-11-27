import { Log } from '$lib/utils/Log';
import { isMailEligibleAddress } from './eligibility';
import { classifyMailFailure, type MailError } from './mailErrors';
import type { MailApi } from './mailApi';
import type { MailEligibility, MailSession, MailSessionState } from './mailSession';
import type { ConversationSummary, MailActionOp, MailFolder } from './mailTypes';
import { flattenFolders } from './zimbraParse';

/**
 * THE MAIL SCREENS' STATE, IN MEMORY (docs/wiki/mail-client-transport.md#as-built---lot-2).
 *
 * What lot 3's screens read: the session's state, the folder tree, the folder listed and its
 * conversations (paged), the selection for bulk actions, and the inbox's unread count for the
 * navigation badge (D10). It holds no secret and writes nothing to disk; a closed account (D8) or a
 * sign-out empties it ({@link MailStore.reset}).
 *
 * A list answer is applied only if it is the answer to the CURRENT list: every open bumps a
 * generation, and a page that comes back for an older one is dropped - an order and a counter, never
 * a timer.
 */

/** The actions that take a conversation out of the folder listed. */
const LEAVES_FOLDER: ReadonlySet<MailActionOp> = new Set([
  'move',
  'trash',
  'spam',
  'not_spam',
  'delete',
]);

/** The page size of a conversation list. */
export const MAIL_PAGE_SIZE = 50;

/** The eligibility of what a session state names (D1). */
export function eligibilityOf(state: MailSessionState): MailEligibility {
  const address =
    state.kind === 'ready'
      ? state.account.address
      : state.kind === 'needs_password' || state.kind === 'closed'
        ? state.account
        : null;
  if (address === null) return 'unknown';
  return isMailEligibleAddress(address) ? 'eligible' : 'not_eligible';
}

export class MailStore {
  /** The mail session's state (signed out, password needed, ready, closed). */
  sessionState = $state<MailSessionState>({ kind: 'signed_out' });
  /** The folder tree. */
  folders = $state<MailFolder[]>([]);
  /** The folder listed; `null` before the first open. */
  currentFolderId = $state<string | null>(null);
  /** The search typed for the list, in Zimbra's query syntax. */
  query = $state('');
  /** The conversations listed, newest first, every page loaded so far. */
  conversations = $state<ConversationSummary[]>([]);
  /** Whether the server holds more conversations after the last page. */
  hasMore = $state(false);
  /** A list page is being loaded. */
  loading = $state(false);
  /** The last failure of a list or an action, typed, for the screen to word. */
  error = $state<MailError | null>(null);
  /** The ids of the conversations selected for a bulk action. */
  selected = $state<string[]>([]);

  /** The inbox's unread count: the navigation badge (D10). */
  readonly inboxUnread = $derived(this.folders.find((f) => f.role === 'inbox')?.unread ?? 0);
  /** D1 from the Canari account's own address, before any mail sign-in ({@link loadEligibility}). */
  identityEligibility = $state<MailEligibility>('unknown');
  /** D1, what the tab is shown on: the mailbox the session names, else the account's own address. */
  readonly eligibility = $derived.by(() => {
    const fromSession = eligibilityOf(this.sessionState);
    return fromSession === 'unknown' ? this.identityEligibility : fromSession;
  });
  /** The folder listed, found in the tree. */
  readonly currentFolder = $derived(
    flattenFolders(this.folders).find((f) => f.id === this.currentFolderId) ?? null
  );

  private generation = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly api: MailApi,
    private readonly session: MailSession,
    private readonly pageSize: number = MAIL_PAGE_SIZE
  ) {
    this.sessionState = session.state;
    this.unsubscribe = session.onState((state) => {
      this.sessionState = state;
      if (state.kind === 'closed' || state.kind === 'signed_out') this.reset();
    });
  }

  /** Reads D1 from the account's own address (the tab's verdict before any mail sign-in). */
  async loadEligibility(): Promise<void> {
    Log.d('MAIL-STORE', 'load eligibility');
    this.identityEligibility = await this.session.eligibility();
  }

  /** Stops following the session (the screen that made the store is gone). */
  dispose(): void {
    this.unsubscribe();
  }

  /** Empties everything this store holds: a sign-out, or a closed account (D8). */
  reset(): void {
    Log.d('MAIL-STORE', 'reset');
    this.generation++;
    this.folders = [];
    this.currentFolderId = null;
    this.query = '';
    this.conversations = [];
    this.hasMore = false;
    this.loading = false;
    this.error = null;
    this.selected = [];
  }

  /** Reloads the folder tree and its counts. */
  async refreshFolders(): Promise<void> {
    Log.d('MAIL-STORE', 'refresh folders');
    const generation = this.generation;
    try {
      const folders = await this.api.folders();
      if (generation !== this.generation) {
        Log.d('MAIL-STORE', 'a folder tree for a store reset since was dropped');
        return;
      }
      this.folders = folders;
    } catch (err) {
      this.error = classifyMailFailure(err);
      Log.w('MAIL-STORE', `the folders did not load (${this.error.kind})`);
    }
  }

  /** Lists `folderId` (with the search `query`) from its first page; the selection is cleared. */
  async openFolder(folderId: string, query = ''): Promise<void> {
    Log.d('MAIL-STORE', `open folder (search: ${query.trim() ? 'yes' : 'no'})`);
    this.generation++;
    this.currentFolderId = folderId;
    this.query = query;
    this.conversations = [];
    this.hasMore = false;
    this.selected = [];
    this.loading = false;
    await this.loadPage(0);
  }

  /** Loads the next page of the list, when there is one and none is loading. */
  async loadMore(): Promise<void> {
    if (!this.hasMore || this.loading || this.currentFolderId === null) return;
    Log.d('MAIL-STORE', `load more from ${this.conversations.length}`);
    await this.loadPage(this.conversations.length);
  }

  private async loadPage(offset: number): Promise<void> {
    const generation = this.generation;
    const folderId = this.currentFolderId;
    this.loading = true;
    this.error = null;
    try {
      const page = await this.api.conversations({
        folderId,
        query: this.query,
        offset,
        limit: this.pageSize,
      });
      if (generation !== this.generation) {
        Log.d('MAIL-STORE', 'a page for a list opened before this one was dropped');
        return;
      }
      const known = this.conversations.map((c) => c.id);
      // A conversation that moved up between two pages comes back in the next: kept once.
      this.conversations = [
        ...this.conversations,
        ...page.items.filter((c) => !known.includes(c.id)),
      ];
      this.hasMore = page.hasMore;
    } catch (err) {
      if (generation !== this.generation) return;
      this.error = classifyMailFailure(err);
      Log.w('MAIL-STORE', `a list page did not load (${this.error.kind})`);
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  /** Whether `id` is selected. */
  isSelected(id: string): boolean {
    return this.selected.includes(id);
  }

  /** Selects `id`, or unselects it. */
  toggle(id: string): void {
    this.selected = this.isSelected(id)
      ? this.selected.filter((s) => s !== id)
      : [...this.selected, id];
  }

  /** Selects every conversation listed. */
  selectAll(): void {
    this.selected = this.conversations.map((c) => c.id);
  }

  /** Clears the selection. */
  clearSelection(): void {
    this.selected = [];
  }

  /**
   * Applies `op` to `ids` (the selection by default) in ONE call, then updates the list in place and
   * reloads the folder counts. `folderId` is the destination of a move. Rethrows the typed failure:
   * an action is a press, and the screen that pressed it owes the answer.
   */
  async act(
    op: MailActionOp,
    ids: readonly string[] = this.selected,
    folderId?: string
  ): Promise<void> {
    const targets = [...ids];
    Log.d('MAIL-STORE', `act ${op} on ${targets.length}`);
    if (targets.length === 0) return;
    try {
      await this.api.act('conversation', op, targets, {
        folderId,
        listedRole: this.currentFolder?.role ?? null,
      });
    } catch (err) {
      this.error = classifyMailFailure(err);
      Log.w('MAIL-STORE', `act ${op} failed (${this.error.kind})`);
      throw this.error;
    }
    this.applyLocally(op, targets, folderId);
    this.selected = this.selected.filter((id) => !targets.includes(id));
    await this.refreshFolders();
  }

  /** What `op` did to the listed rows, applied without reloading the list. */
  private applyLocally(op: MailActionOp, ids: readonly string[], folderId?: string): void {
    if (LEAVES_FOLDER.has(op) && !(op === 'move' && folderId === this.currentFolderId)) {
      this.conversations = this.conversations.filter((c) => !ids.includes(c.id));
      return;
    }
    this.conversations = this.conversations.map((c) => {
      if (!ids.includes(c.id)) return c;
      switch (op) {
        case 'read':
          return { ...c, unreadCount: 0, flags: { ...c.flags, unread: false } };
        case 'unread':
          return { ...c, unreadCount: c.messageCount, flags: { ...c.flags, unread: true } };
        case 'flag':
          return { ...c, flags: { ...c.flags, flagged: true } };
        case 'unflag':
          return { ...c, flags: { ...c.flags, flagged: false } };
        default:
          return c;
      }
    });
  }
}
