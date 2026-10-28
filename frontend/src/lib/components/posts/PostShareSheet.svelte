<script lang="ts">
  /**
   * A POST'S OR A REEL'S SHARE SHEET, AS INSTAGRAM DRAWS IT (user, 2026-10-23, read on the user's
   * phone): a bottom sheet with a grabber, a search field, a three-column grid of the member's
   * conversations - most recent first - and, fixed under it, a row of round actions: "Copier le
   * lien" first, then the system sheet ("Partager via...", phone apps only). No presence dot and no
   * story: Canari has neither.
   *
   * A tap on a conversation sends the post's LINK into it the way a share from another app goes
   * (`sendPostLinkInApp`): that conversation opens with the link in its composer, and the member
   * sends with Send. The link names the post and nothing else; in the conversation it draws the
   * in-app card, which every reader fetches under their own session, so a reader who may not see
   * the post sees "unavailable" and no word of it. See `docs/wiki/frontend/sharing.md`.
   *
   * Mounted by the post menu (`PostActionsMenu`) and by the reel viewer (`ReelViewer`): from inside
   * the viewer, `Modal` takes the viewer's dialog rung on its own (`utils/viewerLayer.ts`).
   */
  import { Hash, Link, Search, Share2 } from '@lucide/svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import GroupAvatar from '$lib/components/shared/GroupAvatar.svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import {
    globalChannels,
    globalConvs,
    globalSession,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { missingPeerNameIds, shareCandidates } from '$lib/sharing/shareDestinations';
  import { canShareOut } from '$lib/sharing/shareOut';
  import { copyPostLink, sendPostLinkInApp, sharePostLinkOut } from '$lib/posts/sharePost';
  import { resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    open: boolean;
    /** The post (a reel is a post) whose link is shared. */
    postId: string;
    onClose: () => void;
    /**
     * The link was sent INTO a conversation and its landing published. A surface drawn over the
     * conversations (the reel viewer) closes on it: the landing no longer navigates, so nothing
     * else would take it off the composer the link waits in.
     */
    onSentInApp?: () => void;
  }

  let { open, postId, onClose, onSentInApp }: Props = $props();

  let query = $state('');
  /** DM names fetched after the grid was first drawn - see `missingPeerNameIds`. */
  let peerNames = $state<Record<string, string>>({});

  const nativeShare = canShareOut();

  $effect(() => {
    if (!open) return;
    for (const id of missingPeerNameIds(
      globalConvs.conversations.entries(),
      globalSession.userId
    )) {
      void resolveUserDisplayName(id).then((name) => {
        if (name) peerNames = { ...peerNames, [id]: name };
      });
    }
  });

  const candidates = $derived(
    open
      ? shareCandidates({
          conversations: globalConvs.conversations.entries(),
          currentUserId: globalSession.userId,
          workspaces: globalChannels.channelWorkspaces,
          peerNames,
          query,
          order: 'recent',
        })
      : []
  );

  function close() {
    query = '';
    onClose();
  }

  /**
   * Each row closes the sheet, then acts - on the id read BEFORE the close. A host that unmounts
   * the sheet by clearing what it passed as `postId` (the reel viewer's `shareFor = null`) would
   * otherwise hand the action a null id, and every row would do nothing.
   */
  function act(action: (id: string) => void) {
    const id = postId;
    close();
    action(id);
  }

  /** The round action of the bottom row: one shape for every entry. */
  const ACTION =
    'flex w-18 shrink-0 flex-col items-center gap-1.5 text-xs text-text-main outline-none focus-visible:underline';
  const ACTION_DISC =
    'flex h-12 w-12 items-center justify-center rounded-full bg-black/5 dark:bg-white/10';
</script>

<Modal {open} title={m.post_share_label()} showTitleBar={false} onClose={close} bodyClass="">
  <div class="flex flex-col gap-3">
    <span class="mx-auto h-1 w-10 rounded-full bg-current opacity-25" aria-hidden="true"></span>

    <div class="relative">
      <Search size={16} class="text-text-muted absolute top-1/2 left-3 -translate-y-1/2" />
      <input
        type="search"
        bind:value={query}
        placeholder={m.chat_search_discussion_placeholder()}
        aria-label={m.chat_search_discussion_label()}
        class="border-cn-border text-text-main focus:border-cn-yellow w-full rounded-xl border bg-(--cn-surface) py-2.5 pr-3 pl-9 text-sm outline-none"
      />
    </div>

    <div class="-mx-1 max-h-[45dvh] overflow-y-auto px-1" data-share-grid>
      {#if candidates.length === 0}
        <p class="text-text-muted py-8 text-center text-sm">{m.chat_no_discussion_found()}</p>
      {:else}
        <ul class="grid grid-cols-3 gap-x-2 gap-y-4">
          {#each candidates as cand (cand.key)}
            <li>
              <button
                type="button"
                onclick={() =>
                  act((id) => {
                    if (sendPostLinkInApp(id, cand.conversation.id)) onSentInApp?.();
                  })}
                aria-label={m.post_share_send_to({ name: cand.label })}
                class="flex w-full flex-col items-center gap-1.5 rounded-xl px-1 py-1 text-center transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              >
                <span class="h-14 w-14 shrink-0">
                  {#if cand.conversation.conversationType === 'direct'}
                    <Avatar
                      userId={cand.conversation.directPeerId ?? cand.conversation.contactName}
                      fill
                      fallbackLabel={cand.label}
                    />
                  {:else if cand.conversation.conversationType === 'channel'}
                    <span
                      class="text-text-muted flex h-full w-full items-center justify-center rounded-full bg-black/5 dark:bg-white/10"
                    >
                      <Hash size={22} strokeWidth={2.5} />
                    </span>
                  {:else}
                    <GroupAvatar
                      imageMediaId={cand.conversation.imageMediaId}
                      name={cand.label}
                      variant="group"
                      fill
                    />
                  {/if}
                </span>
                <span class="text-text-main line-clamp-2 w-full text-xs leading-tight">
                  <EmojiText text={cand.label} />
                </span>
                {#if cand.community}
                  <span class="text-text-muted text-2xs w-full truncate">
                    <EmojiText text={cand.community} />
                  </span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div
      class="border-cn-border -mx-6 flex gap-2 overflow-x-auto border-t px-6 pt-3"
      role="group"
      aria-label={m.post_share_label()}
    >
      <button type="button" class={ACTION} onclick={() => act(copyPostLink)}>
        <span class={ACTION_DISC}><Link size={20} strokeWidth={2.25} /></span>
        {m.post_copy_link_label()}
      </button>
      {#if nativeShare}
        <button type="button" class={ACTION} onclick={() => act(sharePostLinkOut)}>
          <span class={ACTION_DISC}><Share2 size={20} strokeWidth={2.25} /></span>
          {m.post_share_system_label()}
        </button>
      {/if}
    </div>
  </div>
</Modal>
