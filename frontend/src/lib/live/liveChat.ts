/**
 * THE LIVE CHAT, CLIENT SIDE (WP-L6): one {@link LiveChatSession} per open viewer or broadcaster.
 *
 * It owns NO timer. The chat rides the manifest poll the player already makes (decision C3 in
 * docs/wiki/services/lives.md): the poll asks {@link LiveChatSession.query} for the cursors before
 * each request and hands the answer's `chat` block to {@link LiveChatSession.receive}. One request a
 * tick, one loop - so the chat cannot outlive the player, and a viewer the player stopped (ended,
 * removed, full) stops chatting with it.
 *
 * - Messages are sealed and opened with the live key (`liveChatCrypto.ts`); one that does not open is
 *   DROPPED and logged, never drawn.
 * - The cursors move when a block ARRIVES, so the next poll never asks for the same rows again (the
 *   same reactions would float twice); the rows are then drawn in arrival order (a chain), each in
 *   its own try, so a malformed row is dropped and never freezes the chat.
 * - Rows are deduped on `author:clientId`, the server's idempotence key, not only on its id.
 * - A message I sent is drawn at once (`pending`) and REPLACED by the server's copy, matched by its
 *   `clientId` - so it is never drawn twice. Its echo from the poll is OPENED once, as every other
 *   viewer opens it: if it does not open (or the server stored it under another author), the line
 *   says `unreadable`, never "sent". A retry re-sends the SAME sealed bytes (the server's repeat is
 *   idempotent for identical bytes only).
 * - Taps are summed and leave as ONE burst per tick (C7), on the next {@link query}; my own taps float
 *   at once, and the server leaves them out of the sums it serves back (C10).
 *
 * Plain text only (C15): a message is drawn as text, never as markup or a link.
 */
import { reactionTypeToEmoji, reactionTypeToLabel } from '$lib/posts/reactions';
import { Log } from '$lib/utils/Log';
import { isTransportFailure } from '$lib/utils/transportFailure';
import {
  LiveRefusalError,
  fetchLiveManifest,
  hideLiveMessage,
  isLiveRefusal,
  postLiveMessage,
  postLiveReactions,
} from './api';
import { LIVE_MANIFEST_POLL_MS } from './constants';
import { liveRetryDelayMs } from './liveViewerState';
import { LiveChatOpenError, openLiveChatMessage, sealLiveChatMessage } from './liveChatCrypto';
import type {
  LiveChatBlock,
  LiveChatMessageWire,
  LiveChatQuery,
  LiveChatTombstoneWire,
  LiveLimits,
  LiveReactionKind,
} from './types';

const TAG = 'LiveChat';

/**
 * How many lines a session keeps on screen. A display bound, not a server number: older lines leave
 * the list (a live chat is a moment, not an archive - C1), so memory stays flat for a whole hour.
 */
export const LIVE_CHAT_KEPT_LINES = 200;

/** The five kinds, in the order the reaction bar draws them (the server's `LIVE_REACTION_KINDS`). */
export const LIVE_REACTION_KINDS: readonly LiveReactionKind[] = [
  'like',
  'love',
  'laugh',
  'happy',
  'canari',
];

/**
 * Each live kind as the post reaction it is (C8): the SAME emoji (drawn as Noto SVG by `EmojiText`)
 * and the same localised name, so a live and a post never disagree on what a heart means.
 */
const POST_REACTION_OF: Record<LiveReactionKind, string> = {
  like: "J'aime",
  love: "J'adore",
  laugh: 'Rire',
  happy: 'Joyeux',
  canari: 'Canari',
};

/** The emoji of a live reaction kind - the post reaction's. */
export function liveReactionEmoji(kind: LiveReactionKind): string {
  return reactionTypeToEmoji(POST_REACTION_OF[kind]);
}

/** The localised name of a live reaction kind - the post reaction's. */
export function liveReactionLabel(kind: LiveReactionKind): string {
  return reactionTypeToLabel(POST_REACTION_OF[kind]);
}

/**
 * Why a send did not land - decided at the throw, so the panel switches on it:
 * `empty` / `too-long` (refused before sealing), `too-fast` (429), `network` (no answer - retry
 * re-sends the same bytes), `muted`, `removed`, `ended`, `refused` (any other verdict), and
 * `unreadable`: the server stored it, but under an author other than the one it was sealed for, or
 * its echo did not open - so every OTHER viewer drops it, and saying "sent" would be a lie.
 */
export type LiveChatSendFailure =
  | 'unreadable'
  | 'empty'
  | 'too-long'
  | 'too-fast'
  | 'network'
  | 'muted'
  | 'removed'
  | 'ended'
  | 'refused';

/** One line of the chat as the panel draws it. */
export interface LiveChatLine {
  /** The server's id; `null` while my own message is on its way. */
  id: string | null;
  clientId: string;
  authorId: string;
  text: string;
  /** The server's order; `null` while pending. */
  seq: number | null;
  /** My own message: `pending`, `sent`, or `failed` with why. Anyone else's is `sent`. */
  status: 'pending' | 'sent' | 'failed';
  failure?: LiveChatSendFailure;
  mine: boolean;
}

/** What the session needs from outside - the network, the seal, an id. Faked in tests. */
export interface LiveChatDeps {
  postMessage: typeof postLiveMessage;
  postReactions: typeof postLiveReactions;
  hideMessage: typeof hideLiveMessage;
  seal: typeof sealLiveChatMessage;
  open: typeof openLiveChatMessage;
  newId(): string;
}

/** Options of a {@link LiveChatSession}. */
export interface LiveChatSessionOptions {
  liveId: string;
  /**
   * My account id, READ AT EACH USE (the account may load after the screen opened), or null when
   * not known: then I can read and react, not write.
   */
  me(): string | null;
  /** Told the whole list after every change. */
  onChange(lines: readonly LiveChatLine[]): void;
  /** Told reactions to float: mine at the tap, everyone else's as each poll brings them. */
  onFloat?(kind: LiveReactionKind, count: number): void;
  deps?: Partial<LiveChatDeps>;
}

const defaultDeps: LiveChatDeps = {
  postMessage: postLiveMessage,
  postReactions: postLiveReactions,
  hideMessage: hideLiveMessage,
  seal: sealLiveChatMessage,
  open: openLiveChatMessage,
  newId: () => crypto.randomUUID(),
};

/** The failure a refused or unanswered send means - the ONE classification. */
export function liveChatSendFailure(error: unknown): LiveChatSendFailure {
  if (error instanceof LiveRefusalError) {
    if (error.kind === 'rate-limited') return 'too-fast';
    if (error.kind === 'removed') return 'removed';
    if (error.kind === 'ended' || error.kind === 'not-found') return 'ended';
    if (error.code === 'LIVE_MUTED') return 'muted';
    if (error.kind === 'unavailable' || error.kind === 'seats-unavailable') return 'network';
    return 'refused';
  }
  if (isTransportFailure(error)) return 'network';
  return 'refused';
}

function isTombstone(m: LiveChatMessageWire | LiveChatTombstoneWire): m is LiveChatTombstoneWire {
  return 'hidden' in m && m.hidden === true;
}

/** ONE CHAT PER OPEN LIVE SCREEN. See the module comment. */
export class LiveChatSession {
  private readonly deps: LiveChatDeps;
  private readonly liveId: string;
  private readonly opts: LiveChatSessionOptions;
  /** My lines whose echo from the poll OPENED: proof every other viewer can read them (once each). */
  private readonly verifiedEchoes = new Set<string>();

  private keyHex: string | null = null;
  private maxChars: number | null = null;
  private tapCap: number | null = null;
  private messagesAfter: number | undefined;
  private reactionsAfter: number | undefined;
  private lines: LiveChatLine[] = [];
  /** The sealed bytes of each of my messages not yet acknowledged, by clientId - what a retry re-sends. */
  private readonly sealedByClientId = new Map<string, string>();
  private taps: Partial<Record<LiveReactionKind, number>> = {};
  private tapCount = 0;
  /** Blocks are applied one after another, in arrival order. */
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(opts: LiveChatSessionOptions) {
    this.opts = opts;
    this.liveId = opts.liveId;
    this.deps = { ...defaultDeps, ...opts.deps };
  }

  /** My account id now, lower case, as the server stores and serves it. */
  private get me(): string | null {
    return this.opts.me()?.toLowerCase() ?? null;
  }

  /** The lines on screen now, oldest first. */
  get current(): readonly LiveChatLine[] {
    return this.lines;
  }

  /** Whether the key is held - the half of `canWrite` a screen cannot read reactively. */
  get keyed(): boolean {
    return this.keyHex !== null;
  }

  /** Whether a message can be written: the key is held and I am known. */
  get canWrite(): boolean {
    return this.keyHex !== null && this.me !== null && !this.stopped;
  }

  /** The live's key, from `GET /api/lives/:id` (the player's open) - never logged. */
  setKey(keyHex: string): void {
    Log.d(TAG, { op: 'key', liveId: this.liveId });
    this.keyHex = keyHex;
  }

  /** The player's hook (`LivePlayerChatHook.onKey`): the key its open fetched. */
  onKey(keyHex: string): void {
    this.setKey(keyHex);
  }

  /** The server's numbers (`GET /api/lives/limits`): the longest message and a burst's taps. */
  setLimits(limits: Pick<LiveLimits, 'chatMessageMaxChars' | 'reactionTapsPerWindow'>): void {
    this.maxChars = limits.chatMessageMaxChars;
    this.tapCap = limits.reactionTapsPerWindow;
  }

  /** The longest message, or null before the limits arrived. */
  get messageMaxChars(): number | null {
    return this.maxChars;
  }

  /**
   * THE TICK: what the next manifest poll asks of the chat. Also flushes the taps of the tick just
   * gone as ONE burst (fire and forget - a dropped burst is a lost moment, never retried).
   */
  query(): LiveChatQuery {
    this.flushTaps();
    return { messagesAfter: this.messagesAfter, reactionsAfter: this.reactionsAfter };
  }

  /** A poll's `chat` block (absent when the server did not serve one). Applied in arrival order. */
  receive(block: LiveChatBlock | undefined): Promise<void> {
    if (!block || this.stopped) return this.chain;
    if (this.keyHex === null) {
      // The player opens the key before its first poll; reaching this is a wiring defect. The
      // cursors stay, so the next poll asks for these rows again.
      console.error(
        `[LIVE_CHAT] ${this.liveId}: a chat block arrived before the key - not applied`
      );
      return this.chain;
    }
    // THE CURSORS MOVE NOW, at arrival, not when the asynchronous opening is done: the next tick's
    // `query()` may run before this block is drawn, and asking from the old cursors would bring the
    // same rows - the same reactions floating twice. The rows themselves are drawn in order by the
    // chain below, each in its own try, so moving past them loses none.
    if (Number.isSafeInteger(block.messagesCursor)) this.messagesAfter = block.messagesCursor;
    else console.error(`[LIVE_CHAT] ${this.liveId}: a chat block without a message cursor`);
    if (Number.isSafeInteger(block.reactionsCursor)) this.reactionsAfter = block.reactionsCursor;
    else console.error(`[LIVE_CHAT] ${this.liveId}: a chat block without a reaction cursor`);
    this.chain = this.chain
      .then(() => this.apply(block))
      .catch((e: unknown) => {
        // A block that throws must not stall the chain behind it. Rows are tried one by one, so
        // reaching this is a defect in the session itself.
        console.error(`[LIVE_CHAT] ${this.liveId}: a chat block was not applied`, e);
      });
    return this.chain;
  }

  /**
   * Sends one message. Trims it; refuses an empty one or one past the server's length before
   * sealing. Resolves with the failure, or null once the server stored it.
   */
  async send(raw: string): Promise<LiveChatSendFailure | null> {
    const text = raw.trim();
    if (text === '') return 'empty';
    if (this.maxChars !== null && text.length > this.maxChars) {
      console.warn(
        `[LIVE_CHAT] ${this.liveId}: a ${text.length}-char message refused before sealing`
      );
      return 'too-long';
    }
    const me = this.me;
    if (this.stopped || this.keyHex === null || me === null) {
      console.warn(`[LIVE_CHAT] ${this.liveId}: send before the key or the account was known`);
      return 'refused';
    }
    const clientId = this.deps.newId().toLowerCase();
    this.lines = [
      ...this.lines,
      { id: null, clientId, authorId: me, text, seq: null, status: 'pending', mine: true },
    ];
    this.changed();
    let sealed: string;
    try {
      sealed = await this.deps.seal(this.keyHex, this.liveId, clientId, me, text);
    } catch (e) {
      console.error(`[LIVE_CHAT] ${this.liveId}: the message could not be sealed`, e);
      this.markFailed(clientId, 'refused');
      return 'refused';
    }
    this.sealedByClientId.set(clientId, sealed);
    return this.deliver(clientId, sealed);
  }

  /** Sends a failed message of mine again, with the SAME bytes. */
  async retry(clientId: string): Promise<LiveChatSendFailure | null> {
    const sealed = this.sealedByClientId.get(clientId);
    if (!sealed) {
      console.warn(`[LIVE_CHAT] ${this.liveId}: retry of ${clientId}, which holds no sealed bytes`);
      return 'refused';
    }
    this.lines = this.lines.map((l) =>
      l.clientId === clientId ? { ...l, status: 'pending', failure: undefined } : l
    );
    this.changed();
    return this.deliver(clientId, sealed);
  }

  /** Drops a failed message of mine from the list. */
  discard(clientId: string): void {
    this.sealedByClientId.delete(clientId);
    this.lines = this.lines.filter((l) => !(l.clientId === clientId && l.status === 'failed'));
    this.changed();
  }

  /** One tap on a reaction: it floats now, and leaves with the tick's burst. */
  tap(kind: LiveReactionKind): void {
    if (this.stopped) return;
    if (this.tapCap !== null && this.tapCount >= this.tapCap) {
      // Past a burst's bound the tap still floats here; the server would refuse the whole burst.
      Log.d(TAG, { op: 'tap', capped: true });
    } else {
      this.taps[kind] = (this.taps[kind] ?? 0) + 1;
      this.tapCount++;
    }
    this.opts.onFloat?.(kind, 1);
  }

  /**
   * The broadcaster or staff hides a message (C14). The line goes at once on success; everyone
   * else's goes at their next poll (the tombstone). Resolves true when the server took it.
   */
  async hide(messageId: string): Promise<boolean> {
    try {
      await this.deps.hideMessage(this.liveId, messageId);
    } catch (e) {
      console.warn(`[LIVE_CHAT] ${this.liveId}: hiding ${messageId} failed (${String(e)})`);
      return false;
    }
    console.log(`[LIVE_CHAT] ${this.liveId}: message ${messageId} hidden`);
    this.lines = this.lines.filter((l) => l.id !== messageId);
    this.changed();
    return true;
  }

  /** The screen closed: nothing more is sent or drawn. */
  stop(): void {
    Log.d(TAG, { op: 'stop', liveId: this.liveId, lines: this.lines.length });
    this.stopped = true;
    this.taps = {};
    this.tapCount = 0;
  }

  // ------------------------------------------------------------------------------------------

  /** Draws the list: the server's order (`seq`), my pending lines last, then the display bound. */
  private changed(): void {
    // `Array.prototype.sort` is stable, so pending lines keep the order they were written in.
    const PENDING = Number.MAX_SAFE_INTEGER;
    this.lines = [...this.lines].sort((a, b) => (a.seq ?? PENDING) - (b.seq ?? PENDING));
    if (this.lines.length > LIVE_CHAT_KEPT_LINES) {
      this.lines = this.lines.slice(this.lines.length - LIVE_CHAT_KEPT_LINES);
    }
    this.opts.onChange(this.lines);
  }

  private markFailed(clientId: string, failure: LiveChatSendFailure): void {
    this.lines = this.lines.map((l) =>
      l.mine && l.clientId === clientId && l.status !== 'failed'
        ? { ...l, status: 'failed', failure }
        : l
    );
    this.changed();
  }

  private async deliver(clientId: string, sealed: string): Promise<LiveChatSendFailure | null> {
    try {
      const stored = await this.deps.postMessage(this.liveId, clientId, sealed);
      this.sealedByClientId.delete(clientId);
      if (isTombstone(stored)) {
        // Hidden before my retry reached it: the line goes.
        this.lines = this.lines.filter((l) => !(l.mine && l.clientId === clientId));
        this.changed();
        return null;
      }
      // The seal bound the author I believed I was; the server stored the one the gateway says I
      // am. Two different ids mean every other viewer drops this message - said, never "sent".
      const author = typeof stored.authorId === 'string' ? stored.authorId.toLowerCase() : null;
      const sealedAs = this.lines.find((l) => l.mine && l.clientId === clientId)?.authorId;
      if (author === null || (sealedAs !== undefined && author !== sealedAs)) {
        console.error(
          `[LIVE_CHAT] ${this.liveId}: message ${clientId} stored under another author than it was sealed for - unreadable to everyone else`
        );
        this.markFailed(clientId, 'unreadable');
        return 'unreadable';
      }
      this.confirm(stored.id, stored.seq, clientId);
      this.changed();
      return null;
    } catch (e) {
      const failure = liveChatSendFailure(e);
      console.warn(`[LIVE_CHAT] ${this.liveId}: message ${clientId} not sent (${failure})`);
      this.markFailed(clientId, failure);
      return failure;
    }
  }

  /** My pending line becomes the server's, wherever the answer or a poll brought it first. */
  private confirm(id: string, seq: number, clientId: string): void {
    const already = this.lines.some((l) => l.id === id);
    this.lines = already
      ? this.lines.filter((l) => !(l.clientId === clientId && l.id === null))
      : this.lines.map((l) =>
          l.clientId === clientId && l.mine
            ? { ...l, id, seq, status: 'sent', failure: undefined }
            : l
        );
  }

  private flushTaps(): void {
    if (this.tapCount === 0 || this.stopped) return;
    const counts = this.taps;
    const taps = this.tapCount;
    this.taps = {};
    this.tapCount = 0;
    const burstId = this.deps.newId().toLowerCase();
    this.deps.postReactions(this.liveId, burstId, counts).catch((e: unknown) => {
      // A burst is a moment: a refused or lost one is dropped, said, never retried.
      console.warn(`[LIVE_CHAT] ${this.liveId}: a burst of ${taps} taps dropped (${String(e)})`);
    });
  }

  private async apply(block: LiveChatBlock): Promise<void> {
    const key = this.keyHex;
    if (this.stopped || key === null) return;
    const messages = Array.isArray(block.messages) ? block.messages : [];
    let dropped = 0;
    for (const m of messages) {
      // EVERY row is handled inside its own try: one malformed row is dropped and said, never a
      // throw that leaves the rest of the block - and every later block - undrawn.
      try {
        if (!(await this.applyOne(key, m))) dropped++;
      } catch (e) {
        dropped++;
        console.warn(`[LIVE_CHAT] ${this.liveId}: a chat row dropped (${String(e)})`);
      }
      if (this.stopped) return;
    }
    if (messages.length > 0) {
      Log.d(TAG, { op: 'receive', messages: messages.length, dropped });
      this.changed();
    }
    for (const w of Array.isArray(block.reactions) ? block.reactions : []) {
      for (const kind of LIVE_REACTION_KINDS) {
        const n = w?.counts?.[kind];
        if (typeof n === 'number' && n > 0) this.opts.onFloat?.(kind, n);
      }
    }
  }

  /**
   * One row of a block. Resolves false when it was dropped (malformed, or did not open).
   * DEDUPED ON `author:clientId` - the server's idempotence key - not only on the server id, so a
   * replay of a message under a new id is never drawn twice.
   */
  private async applyOne(
    key: string,
    m: LiveChatMessageWire | LiveChatTombstoneWire
  ): Promise<boolean> {
    if (isTombstone(m)) {
      this.lines = this.lines.filter((l) => l.id !== m.id);
      return true;
    }
    if (
      typeof m.id !== 'string' ||
      typeof m.seq !== 'number' ||
      typeof m.authorId !== 'string' ||
      typeof m.clientId !== 'string' ||
      typeof m.sealed !== 'string'
    ) {
      console.warn(`[LIVE_CHAT] ${this.liveId}: a malformed chat row dropped`);
      return false;
    }
    const author = m.authorId.toLowerCase();
    const clientId = m.clientId.toLowerCase();
    const mine = author === this.me;
    const drawn = this.lines.find((l) => l.authorId === author && l.clientId === clientId);
    if (drawn && !(drawn.mine && !this.verifiedEchoes.has(clientId))) return true;
    if (!drawn && this.lines.some((l) => l.id === m.id)) return true;
    let text: string;
    try {
      text = await this.deps.open(key, this.liveId, clientId, author, m.sealed);
    } catch (e) {
      const reason = e instanceof LiveChatOpenError ? e.reason : String(e);
      if (drawn) {
        // MY OWN message, as the poll serves it to everyone, does not open: no other viewer can
        // read it, whatever my screen says.
        console.error(
          `[LIVE_CHAT] ${this.liveId}: my own message ${m.id} does not open from the poll (${reason}) - unreadable to everyone else`
        );
        this.verifiedEchoes.add(clientId);
        this.markFailed(clientId, 'unreadable');
        return false;
      }
      console.warn(`[LIVE_CHAT] ${this.liveId}: message ${m.id} dropped (${reason})`);
      return false;
    }
    if (drawn) {
      // My echo opened: proof the others read it. Confirm the line once, never draw it twice.
      this.verifiedEchoes.add(clientId);
      this.sealedByClientId.delete(clientId);
      this.confirm(m.id, m.seq, clientId);
      return true;
    }
    if (mine) this.verifiedEchoes.add(clientId);
    this.lines.push({
      id: m.id,
      clientId,
      authorId: author,
      text,
      seq: m.seq,
      status: 'sent',
      mine,
    });
    return true;
  }
}

/** What a {@link LiveBroadcasterChatPoller} needs from outside. Faked in tests. */
export interface LiveBroadcasterChatPollerDeps {
  fetchManifest: typeof fetchLiveManifest;
  /** Runs `fn` after `ms`; returns its cancel. */
  schedule(fn: () => void, ms: number): () => void;
}

/**
 * THE BROADCASTER'S CHAT LOOP. A broadcaster plays nothing, so no player polls for it: this is its
 * ONE loop, the same manifest request a viewer makes (`chat=1`, no seat for the broadcaster), one a
 * tick. It stops for good on the live's end (`ended`, or the `not-found` of a live deleted at its
 * end) - the server's verdict, never a timer; any other failure retries after the player's backoff.
 */
export class LiveBroadcasterChatPoller {
  private readonly deps: LiveBroadcasterChatPollerDeps;
  private cancel: (() => void) | null = null;
  private generation = 0;
  private attempt = 0;

  constructor(
    private readonly liveId: string,
    private readonly session: LiveChatSession,
    deps: Partial<LiveBroadcasterChatPollerDeps> = {},
    /** Told once when the live is over and the loop stopped. */
    private readonly onEnded?: () => void
  ) {
    this.deps = {
      fetchManifest: fetchLiveManifest,
      schedule: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      ...deps,
    };
  }

  /** Starts the loop: one poll now, then one a tick. */
  start(): void {
    console.debug(`[LIVE_CHAT] broadcaster chat loop on ${this.liveId}`);
    const gen = ++this.generation;
    void this.tick(gen);
  }

  /** Stops the loop; an answer in flight is ignored. */
  stop(): void {
    this.generation++;
    this.cancel?.();
    this.cancel = null;
  }

  private async tick(gen: number): Promise<void> {
    let wait = LIVE_MANIFEST_POLL_MS;
    try {
      const manifest = await this.deps.fetchManifest(this.liveId, undefined, this.session.query());
      if (gen !== this.generation) return;
      this.attempt = 0;
      await this.session.receive(manifest.chat);
    } catch (e) {
      if (gen !== this.generation) return;
      if (isLiveRefusal(e, 'ended') || isLiveRefusal(e, 'not-found')) {
        console.log(
          `[LIVE_CHAT] broadcaster chat loop on ${this.liveId} stopped: the live is over`
        );
        this.generation++;
        this.onEnded?.();
        return;
      }
      this.attempt++;
      wait = liveRetryDelayMs(this.attempt);
      console.warn(
        `[LIVE_CHAT] broadcaster chat poll failed (${String(e)}), retry ${this.attempt} in ${wait} ms`
      );
    }
    if (gen !== this.generation) return;
    this.cancel = this.deps.schedule(() => {
      this.cancel = null;
      if (gen === this.generation) void this.tick(gen);
    }, wait);
  }
}
