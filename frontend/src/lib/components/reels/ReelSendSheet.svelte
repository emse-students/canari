<script lang="ts">
  /**
   * "ENVOYER A..." - the camera's send sheet (reels-in-chat RC-12, 15.1, 15.8, and the two paths of
   * section 22), over the take's review. SNAPCHAT'S LIST (owner, 2026-11-16): the search at the top,
   * then a "CanaReels" section holding the one row "Publier" (Snapchat's "My Story"), then "Recents"
   * (last activity first), then every other group and DM alphabetically (`reelSendSections`); a round
   * tick per row, a group's row names a few of its members, the ticked targets as chips and
   * "Envoyer (N)" in the footer. The rows are the share picker's (`ConversationPickList`).
   *
   * OPENED FROM A CONVERSATION'S CAMERA ("Ajouter des destinataires", path 2) that conversation is
   * ticked from the start (`preticked`); from the CanaReels tab (path 1) nothing is.
   *
   * IT IS A HISTORY ENTRY ABOVE THE TAKE'S, so Android's Back (and iOS's edge swipe) returns to the
   * review. The sheet decides nothing about the send: `onsend` hands the ticks to `ReelCapture`,
   * which writes ONE take and N sends (`sendChatReelTakeTo`) and/or opens the publish step.
   *
   * THE LIST IS A COURTESY, THE SERVER THE AUTHORITY (`reelSendTargets.ts`): salons are not listed
   * (RC-8), and the cap on chat targets is the server's `chatReelMaxTargets` carried in as `cap` -
   * a tick past it is REFUSED WITH A SENTENCE, never silently.
   */
  import { onMount, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { Check, ChevronLeft, Film, X } from '@lucide/svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import ConversationPickList from '$lib/components/shared/ConversationPickList.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { cachedMuteStatus, getMuteStatus } from '$lib/moderation/muteCheck';
  import { listBlockedUsers } from '$lib/users/blocks';
  import { missingPeerNameIds, type ShareCandidate } from '$lib/sharing/shareDestinations';
  import { resolveUserDisplayName } from '$lib/utils/users/displayName';
  import {
    reelSendCandidates,
    reelSendKeyOf,
    reelSendSections,
    toggleReelTarget,
  } from '$lib/reels/reelSendTargets';
  import type { ReelSendHost } from '$lib/reels/reelSendBridge';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import type { ReelClip } from '$lib/reels/reelCapture';
  import { reelPickRefusal, type ReelRule } from '$lib/reels/reelRule';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    clip: ReelClip;
    /**
     * The messaging layer: the conversations listed, the account, and (optional) a group's members
     * for its subtitle (`reelSendBridge`).
     */
    host: Pick<ReelSendHost, 'conversations' | 'userId'> &
      Partial<Pick<ReelSendHost, 'groupMembers'>>;
    /** The most conversations one take may be sent to (`chatReelTargetCap`): the server's, never a guess. */
    cap: number;
    /** The longest take a conversation accepts (`chatMaxDurationMs`): a longer one can only be posted. */
    chatCapMs: number;
    /**
     * The server's reel rule (`reelRuleOf`), or `null` on an estate that serves none. A conversation
     * keeps vertical AND within its cap, whatever the feed's OR (`reelPickRefusal`, review of #3528).
     */
    rule: ReelRule | null;
    /** Back to the take. */
    onclose: () => void;
    /** The press: whether CanaReels is ticked, and the conversation keys, in tick order. */
    onsend: (choice: { feed: boolean; targetKeys: string[] }) => void;
    /** A press is being written: "Envoyer" waits, so one take can never be queued twice. */
    sending?: boolean;
    /**
     * The conversation (its id) the camera was opened from (path 2): ticked from the start. Absent
     * on the CanaReels tab (path 1).
     */
    preticked?: string | null;
  }

  let {
    clip,
    host,
    cap,
    chatCapMs,
    rule,
    onclose,
    onsend,
    sending = false,
    preticked = null,
  }: Props = $props();

  let query = $state('');
  let feedTicked = $state(false);
  /** Read once: the conversation the camera came from is the first tick, the member's to remove. */
  let selected = $state<string[]>(untrack(() => initialSelection()));
  let capNotice = $state(false);
  let peerNames = $state<Record<string, string>>({});
  /** A group's subtitle by conversation id: a few of its members' names (`groupMembers`). */
  let groupSubtitles = $state<Record<string, string>>({});
  /**
   * The groups whose members were asked, so the effect asks each once. NOT reactive on purpose: the
   * effect writes it, and a reactive set would re-run the effect on its own write.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- the effect's own ledger, never rendered
  const subtitlesAsked = new Set<string>();
  /**
   * ONE NAME LOOKUP PER DISTINCT USER, whichever groups they are in (not three per group): the
   * pending or settled answer by user id. Not reactive, for the reason above.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a lookup cache, never rendered
  const memberNames = new Map<string, Promise<string | null>>();
  const blockedPeerIds = new SvelteSet<string>();
  /**
   * Whether the blocked list was ANSWERED. A block does not refuse a DM message server-side
   * (moderation-and-blocking.md: a failure to ask is not an answer), so until it is read - and for
   * good if the read fails - the chat rows stay disabled rather than listing a blocked person.
   */
  let blocksState = $state<'pending' | 'read' | 'failed'>('pending');
  /** `null` until asked: the feed row is not offered as muted on a guess. */
  let muted = $state<boolean | null>(cachedMuteStatus()?.isMuted ?? null);
  let heading = $state<HTMLElement | null>(null);

  /**
   * A photo reaches each chat as its own ordinary image (D-photo), not the post's file: the
   * "same as the post" sentence is a video's.
   */
  const isPhoto = $derived(clip.blob.type.startsWith('image/'));
  /** A silenced take cannot reach a chat: the audio track is dropped only by the feed's publish. */
  const silenced = $derived(clip.soundRemoved === true);
  /**
   * Whether a conversation refuses this take, by the chat rule (vertical AND within `chatCapMs`) - the
   * function the camera's chat pick uses, so the sheet never offers a chat the pick would refuse. A
   * length that is not known refuses nothing (the outbox still refuses a long one).
   *
   * THE FRAME IS JUDGED ON A GALLERY PICK ONLY (review of #3528): a camera take was filmed in the
   * reel frame, and the chat camera's one-tap send (`handBack`) sends it with no frame check, so the
   * sheet judging it would refuse the same take the other button sends. A camera take is judged on
   * its length alone (`rule` null: the cap). A PHOTO is never judged: it reaches each chat as its own
   * image (D-photo), and it has no length and no read frame.
   */
  const chatRefusal = $derived(
    isPhoto
      ? null
      : reelPickRefusal(
          {
            durationMs: clip.durationMs ?? null,
            width: clip.width ?? null,
            height: clip.height ?? null,
          },
          clip.source === 'gallery' ? rule : null,
          chatCapMs,
          'chat'
        )
  );
  const tooLong = $derived(chatRefusal?.reason === 'too-long');
  const notVertical = $derived(chatRefusal?.reason === 'not-vertical');
  const frameUnread = $derived(chatRefusal?.reason === 'frame-unread');
  const chatsBlocked = $derived(silenced || chatRefusal !== null || blocksState !== 'read');
  const feedMuted = $derived(muted === true);
  /** The feed row waits for the mute answer; a tick made before it never survives (`feedSend`). */
  const feedUnknown = $derived(muted === null);
  const feedSend = $derived(feedTicked && muted === false);

  /** How many member names a group's row shows (Snapchat shows a few). */
  const SUBTITLE_NAMES = 3;

  const overlay = bindHistoryOverlay(
    () => true,
    () => onclose()
  );

  /** The tick the sheet opens with: the camera's own conversation (path 2), or none (path 1). */
  function initialSelection(): string[] {
    if (preticked === null) return [];
    const key = reelSendKeyOf(host.conversations(), preticked);
    console.debug(`[reel-send] opened from a conversation: ${key ? 'ticked' : 'not held here'}`);
    return key ? [key] : [];
  }

  $effect(() => {
    for (const id of missingPeerNameIds(host.conversations(), host.userId())) {
      void resolveUserDisplayName(id).then((name) => {
        if (name) peerNames = { ...peerNames, [id]: name };
      });
    }
  });

  /**
   * EVERY CONVERSATION THE SHEET LISTS, whatever the search says: what a tick must still belong to,
   * and where a ticked target's chip reads its name - a chip hidden from the filtered rows by the
   * search is still named, never shown as its raw key (iPhone 12 reading, 2026-11-16).
   */
  const listed = $derived(
    reelSendCandidates({
      conversations: host.conversations(),
      currentUserId: host.userId(),
      peerNames,
      query: '',
      blockedPeerIds,
    })
  );
  /** The rows the search keeps (all of them with no search). */
  const candidates = $derived(
    query.trim()
      ? reelSendCandidates({
          conversations: host.conversations(),
          currentUserId: host.userId(),
          peerNames,
          query,
          blockedPeerIds,
        })
      : listed
  );
  const sections = $derived(reelSendSections(candidates, query));
  const listedByKey = $derived(new SvelteMap(listed.map((c) => [c.key, c])));
  /**
   * THE SEND SET IS selected AND currently listed, in tick order: a tick on a row that is no longer
   * one is dropped. Each carries its full-list row, so its chip is named whatever the search hides.
   */
  const sendTargets = $derived(
    chatsBlocked
      ? []
      : selected.flatMap((k) => {
          const cand = listedByKey.get(k);
          return cand ? [cand] : [];
        })
  );
  const sendKeys = $derived(sendTargets.map((c) => c.key));
  const count = $derived(sendKeys.length + (feedSend ? 1 : 0));

  // A GROUP'S ROW NAMES A FEW MEMBERS (owner, 2026-11-16). Read from the LOCAL trees in ONE batch
  // once MLS is ready (`groupMembers`), no server call; a group this device does not hold yet (not
  // `active`) is not asked - its tree is not here. Every listed group, whatever the search shows.
  $effect(() => {
    const read = host.groupMembers;
    if (!read) return;
    const me = host.userId();
    const ids = listed
      .map((cand) => cand.conversation)
      .filter((c) => c.conversationType === 'group' && c.lifecycle === 'active')
      .map((c) => c.id)
      .filter((id) => !subtitlesAsked.has(id));
    if (ids.length === 0) return;
    for (const id of ids) subtitlesAsked.add(id);
    console.debug(`[reel-send] the members of ${ids.length} group(s) asked`);
    void untrack(() => fillSubtitles(read, ids, me));
  });

  /** The name of one member, asked once for the whole sheet; a failed lookup names nobody, said. */
  function memberName(userId: string): Promise<string | null> {
    let pending = memberNames.get(userId);
    if (!pending) {
      pending = resolveUserDisplayName(userId).catch((e: unknown) => {
        console.warn('[reel-send] a group member name could not be resolved', e);
        return null;
      });
      memberNames.set(userId, pending);
    }
    return pending;
  }

  /**
   * The subtitles of `groupIds`: the first {@link SUBTITLE_NAMES} other members of each, every
   * distinct member named once. A group the host could not read gets none (the host said it).
   */
  async function fillSubtitles(
    read: NonNullable<Props['host']['groupMembers']>,
    groupIds: string[],
    me: string
  ) {
    const members = await read(groupIds);
    const shownIds = new SvelteMap(
      [...members].map(([gid, users]) => [
        gid,
        users.filter((u) => u !== me).slice(0, SUBTITLE_NAMES),
      ])
    );
    const distinct = [...new SvelteSet([...shownIds.values()].flat())];
    const names = new SvelteMap(
      await Promise.all(distinct.map(async (u) => [u, await memberName(u)] as const))
    );
    const next = { ...groupSubtitles };
    for (const [gid, users] of shownIds) {
      const shown = users
        .map((u) => names.get(u))
        .filter((n): n is string => !!n && n.trim().length > 0);
      if (shown.length > 0) next[gid] = shown.join(', ');
    }
    groupSubtitles = next;
  }

  onMount(() => {
    overlay.syncOpen();
    heading?.focus();
    // THE MUTE AND THE BLOCKS ARE ASKED ONCE, WHEN THE SHEET OPENS (15.8); the server answers again
    // at the publish and at each send. A failed read lists everything: the server is the authority.
    void getMuteStatus().then(
      (s) => (muted = s.isMuted),
      // The publish step asks the mute again before anything is uploaded, so a failed read here
      // leaves the feed row open: that ask is the answer.
      (e: unknown) => {
        console.warn(
          '[reel-send] the mute status could not be read - the publish step asks again',
          e
        );
        muted = false;
      }
    );
    void listBlockedUsers().then(
      (rows) => {
        blockedPeerIds.clear();
        for (const r of rows) blockedPeerIds.add(r.userId);
        blocksState = 'read';
      },
      (e: unknown) => {
        console.error(
          '[reel-send] the blocked list could not be read: the chat rows stay disabled',
          e
        );
        blocksState = 'failed';
      }
    );
  });

  function toggleFeed() {
    if (feedMuted || feedUnknown) return;
    feedTicked = !feedTicked;
    capNotice = false;
  }

  function toggleTarget(key: string) {
    if (chatsBlocked) return;
    const next = toggleReelTarget(selected, key, cap);
    selected = next.selected;
    capNotice = next.capped;
    if (next.capped) console.debug(`[reel-send] tick refused: ${cap} conversations at most`);
  }

  function send() {
    if (count === 0 || sending) return;
    console.debug(`[reel-send] press: feed=${feedSend}, ${sendKeys.length} conversation(s)`);
    onsend({ feed: feedSend, targetKeys: [...sendKeys] });
  }

  /** A conversation row: a checkbox named "<name>, <kind>", disabled while the chats are withheld. */
  function rowAttrs(cand: ShareCandidate) {
    return {
      role: 'checkbox' as const,
      'aria-checked': selected.includes(cand.key),
      'aria-label': m.reel_sendto_row_label({
        name: cand.label,
        kind:
          cand.conversation.conversationType === 'direct'
            ? m.reel_sendto_kind_direct()
            : m.reel_sendto_kind_group(),
      }),
      disabled: chatsBlocked,
      'data-reel-send-row': cand.key,
    };
  }

  /** The "Publier" row, drawn like the list's own rows (`ConversationPickList`). */
  const ROW =
    'flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors enabled:hover:bg-black/5 dark:enabled:hover:bg-white/5';
</script>

<div
  class="bg-cn-bg text-text-main absolute inset-0 z-20 flex flex-col pb-(--keyboard-occlusion-bottom,0px)"
  in:fade={{ duration: 150 }}
  data-reel-send
>
  <header
    class="border-cn-border bg-cn-surface flex shrink-0 items-center gap-2 border-b px-2 pt-[calc(var(--safe-area-inset-top,0px)+0.5rem)] pb-2"
  >
    <button
      type="button"
      class="ui-icon-button"
      aria-label={m.reel_sendto_back()}
      title={m.reel_sendto_back()}
      onclick={() => overlay.dismissFromUi()}
    >
      <ChevronLeft size={24} strokeWidth={2.5} />
    </button>
    <h1 bind:this={heading} tabindex="-1" class="font-body text-base font-bold outline-none">
      {m.reel_sendto_title()}
    </h1>
  </header>

  <ConversationPickList
    bind:query
    class="flex min-h-0 flex-1 flex-col gap-2 px-3 pt-3"
    listClass="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1 pb-3"
    searchPlaceholder={m.reel_sendto_search()}
    searchLabel={m.reel_sendto_search()}
    searchAttrs={{ type: 'search', 'data-reel-send-search': '' }}
    {sections}
    emptyText={query.trim() ? m.reel_sendto_no_match() : m.reel_sendto_empty()}
    emptyAttrs={{ 'data-reel-send-empty': '' }}
    lead={{ title: m.reel_sendto_section_feed(), body: feedRow }}
    {notice}
    emojiNames
    onpick={(cand) => toggleTarget(cand.key)}
    {rowAttrs}
    subtitle={(cand) => groupSubtitles[cand.conversation.id] ?? null}
  >
    {#snippet trailing(cand)}
      {@render tick(selected.includes(cand.key))}
    {/snippet}
  </ConversationPickList>

  <div
    class="border-cn-border bg-cn-surface shrink-0 border-t px-3 pt-2 pb-[calc(var(--safe-area-inset-bottom,0px)+0.5rem)]"
  >
    {#if capNotice}
      <p role="alert" class="text-amber-warn-text mb-2 text-sm font-semibold" data-reel-send-cap>
        {m.reel_sendto_cap({ count: cap })}
      </p>
    {/if}
    {#if feedSend && sendKeys.length > 0 && !isPhoto}
      <!-- ONE FILE FOR THE FEED AND THE CHATS (15.5, D-onefile): the conversations receive the
           published video itself, under the post's key - said, never claimed end-to-end. -->
      <p class="text-text-muted text-2xs mb-2" role="note" data-reel-send-same-as-post>
        {m.reel_sendto_same_as_post()}
      </p>
    {/if}
    {#if sendKeys.length > 0}
      <ul class="mb-2 flex gap-2 overflow-x-auto" data-reel-send-chips>
        {#each sendTargets as target (target.key)}
          <li class="shrink-0">
            <button
              type="button"
              class="bg-cn-bg border-cn-border text-text-main flex items-center gap-1 rounded-full border py-1 pr-2 pl-3 text-xs"
              aria-label={m.reel_sendto_chip_remove({ name: target.label })}
              onclick={() => toggleTarget(target.key)}
            >
              <span class="max-w-32 truncate"><EmojiText text={target.label} /></span>
              <X size={14} strokeWidth={2.5} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="flex justify-end">
      <Button
        type="button"
        class="shrink-0"
        disabled={count === 0 || sending}
        onclick={send}
        data-reel-send-submit
      >
        {m.reel_sendto_send({ count })}
      </Button>
    </div>
  </div>
</div>

{#snippet feedRow()}
  <Button
    variant="bare"
    role="checkbox"
    aria-checked={feedSend}
    disabled={feedMuted || feedUnknown}
    class={ROW}
    onclick={toggleFeed}
    data-reel-send-feed
  >
    <span
      class="bg-accent/20 text-text-main flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
    >
      <Film size={18} strokeWidth={2.25} />
    </span>
    <span class="min-w-0 flex-1 text-sm font-semibold">{m.reel_sendto_feed_row()}</span>
    {@render tick(feedSend)}
  </Button>
  {#if feedMuted}
    <p class="text-text-muted text-2xs px-2 pb-1" role="note" data-reel-send-muted>
      {m.reel_sendto_feed_muted()}
    </p>
  {/if}
{/snippet}

{#snippet notice()}
  {#if blocksState === 'failed'}
    <p class="text-text-muted text-2xs px-2 pt-2" role="note" data-reel-send-blocks-unread>
      {m.reel_sendto_blocks_unread()}
    </p>
  {:else if silenced}
    <p class="text-text-muted text-2xs px-2 pt-2" role="note" data-reel-send-silent>
      {m.reel_sendto_sound_removed_chats()}
    </p>
  {:else if tooLong}
    <p class="text-text-muted text-2xs px-2 pt-2" role="note" data-reel-send-too-long>
      {m.reel_sendto_too_long_for_chats({ seconds: Math.round(chatCapMs / 1000) })}
    </p>
  {:else if notVertical}
    <p class="text-text-muted text-2xs px-2 pt-2" role="note" data-reel-send-not-vertical>
      {m.reel_sendto_not_vertical_for_chats()}
    </p>
  {:else if frameUnread}
    <p class="text-text-muted text-2xs px-2 pt-2" role="note" data-reel-send-frame-unread>
      {m.reels_capture_frame_unread_for_chats()}
    </p>
  {/if}
{/snippet}

{#snippet tick(on: boolean)}
  <span
    class={[
      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2',
      on ? 'border-accent-icon bg-accent text-on-accent' : 'border-cn-border',
    ]}
    aria-hidden="true"
  >
    {#if on}<Check size={14} strokeWidth={3} />{/if}
  </span>
{/snippet}
