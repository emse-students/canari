<script lang="ts">
  /**
   * THE CANAREELS ENTRY, AN ICON AT THE RIGHT END OF THE FEED'S TAB ROW (user, 2026-10-16, in the
   * spirit of the old IGTV button). A tap goes STRAIGHT INTO the full-screen reel viewer at the top
   * of the list of every reel the member may see, ranked like Pour toi since 1.6.9, whatever tab is
   * open (`reels/allReels.ts`); the viewer covers
   * the whole screen (`coversScreen`) and its close returns to the feed exactly as it was, since the
   * feed never left. It replaces the 2026-10-15 filter bar ("Tous les posts" / "CanaReels"), whose
   * filtered-feed mode is gone (docs/wiki/frontend/modules/reels.md, "The CanaReels entry").
   *
   * The first page is read BEFORE the viewer opens, because an empty viewer is no answer: with no
   * reel yet, a small sheet says so and offers the camera (`ReelsEmptyState`). That page is then
   * the viewer's own first page, not a second request (`allReelsLoader(firstPage)`).
   */
  import { Clapperboard } from '@lucide/svelte';
  import { guideAnchor } from '$lib/guidance/guideAnchors.svelte';
  import ReelViewer from '$lib/components/reels/ReelViewer.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import ReelsEmptyState from './ReelsEmptyState.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import { allReelsLoader, listAllReels } from '$lib/reels/allReels';
  import { preferredReelOrder, rememberReelOrder, type ReelOrder } from '$lib/reels/reelOrder';
  import { expandFrom, type ExpandOrigin } from '$lib/reels/expandFrom';
  import { showToast } from '$lib/stores/toast.svelte';
  import { isTransportFailure } from '$lib/utils/transportFailure';
  import { currentUserId } from '$lib/stores/userState.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Forwarded to the viewer's players, which download and decrypt the reels. */
    authToken: string;
  }

  let { authToken }: Props = $props();

  let opening = $state(false);
  let firstPage = $state<PostEntity[] | null>(null);
  /**
   * "Pour toi" or "Récents" (owner, 2026-11-10: a chronological view must exist), chosen at the top
   * of the stream and remembered on this device (`reelOrder.ts`).
   */
  let order = $state<ReelOrder>(preferredReelOrder());
  /** A change of order is being read: a second tap waits for it. */
  let reordering = $state(false);
  /** ONE loader per opening and order: it keeps the ranking its pages are asked of (`allReelsLoader`). */
  const reelLoader = $derived(firstPage ? allReelsLoader(firstPage, order) : undefined);

  /**
   * The reader picked another order: its first page is read, then the viewer starts over at its top
   * with the new loader. A refusal keeps the stream as it was and says so.
   */
  async function changeOrder(next: ReelOrder) {
    if (next === order || reordering) return;
    reordering = true;
    console.debug(`[reels-entry] order -> ${next}`);
    try {
      const page = await listAllReels(undefined, next);
      // The same reels in another order: an empty answer means they were all withdrawn meanwhile.
      if (page.length === 0) {
        console.warn(`[reels-entry] no reel in the ${next} order - the stream stays as it was`);
        return;
      }
      rememberReelOrder(next);
      order = next;
      firstPage = page;
    } catch (err) {
      if (isTransportFailure(err)) {
        console.info('[reels-entry] no answer for the reordered reels - offline', err);
      } else {
        console.error('[reels-entry] the server refused the reordered reels', err);
      }
      showToast(m.posts_reels_open_error(), 'error');
    } finally {
      reordering = false;
    }
  }
  let emptyOpen = $state(false);
  let entry = $state<HTMLButtonElement | null>(null);
  /** Where the viewer grows from when the View Transitions API is absent (`expandFrom`). */
  let expandOrigin = $state<ExpandOrigin | null>(null);

  async function open() {
    if (opening || firstPage) return;
    opening = true;
    let handedOff = false;
    console.debug('[reels-entry] opening the viewer at the top of the reels list');
    try {
      const page = await listAllReels(undefined, order);
      if (page.length === 0) {
        console.debug('[reels-entry] no reel yet - the empty sheet');
        emptyOpen = true;
        return;
      }
      const opened = page;
      // `opening` stays up until the viewer's page is SET: a view transition runs its commit a
      // moment later, and a second tap in between would open a second viewer.
      handedOff = true;
      const commit = (origin: ExpandOrigin | null) => {
        expandOrigin = origin;
        firstPage = opened;
        opening = false;
      };
      if (entry) expandFrom(entry, commit);
      else commit(null);
    } catch (err) {
      // No answer (offline, a dead network) is the member's situation, not a defect: said, not
      // accused. An ANSWER that refused is a defect and is logged as one.
      if (isTransportFailure(err)) {
        console.info('[reels-entry] no answer for the first reels - offline', err);
      } else {
        console.error('[reels-entry] the server refused the first reels', err);
      }
      showToast(m.posts_reels_open_error(), 'error');
    } finally {
      if (!handedOff) opening = false;
    }
  }
</script>

<button
  type="button"
  bind:this={entry}
  data-reels-entry
  use:guideAnchor={'posts.reels'}
  aria-label={m.posts_reels_open()}
  title={m.posts_reels_open()}
  aria-haspopup="dialog"
  aria-busy={opening}
  onclick={open}
  class="glass-chrome ui-icon-button text-text-muted hover:text-text-main focus-visible:ring-accent-icon rounded-full focus-visible:ring-2 {opening
    ? 'opacity-60'
    : ''}"
>
  <Clapperboard size={18} aria-hidden="true" />
</button>

{#if firstPage}
  <ReelViewer
    startPost={firstPage[0]}
    {authToken}
    loadPage={reelLoader}
    likerId={currentUserId() ?? undefined}
    {expandOrigin}
    orderChoice={{ value: order, busy: reordering, onChange: (next) => void changeOrder(next) }}
    onClose={() => (firstPage = null)}
  />
{/if}

<Modal open={emptyOpen} title={m.reels_viewer_label()} onClose={() => (emptyOpen = false)}>
  <ReelsEmptyState />
</Modal>
