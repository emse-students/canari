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
  import { listAllReels } from '$lib/reels/allReels';
  import { preferredReelOrder } from '$lib/reels/reelOrder';
  import { ReelStream } from '$lib/reels/reelStream.svelte';
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
  /**
   * The stream in the reader's order, and its switch - the one implementation every opener of the
   * stream shares (`reels/reelStream.svelte.ts`). Open while it holds a first page.
   */
  const stream = new ReelStream();
  let emptyOpen = $state(false);
  let entry = $state<HTMLButtonElement | null>(null);
  /** Where the viewer grows from when the View Transitions API is absent (`expandFrom`). */
  let expandOrigin = $state<ExpandOrigin | null>(null);

  async function open() {
    if (opening || stream.firstPage) return;
    opening = true;
    let handedOff = false;
    console.debug('[reels-entry] opening the viewer at the top of the reels list');
    try {
      const order = preferredReelOrder();
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
        stream.open(opened, order);
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

{#if stream.firstPage}
  <ReelViewer
    startPost={stream.firstPage[0]}
    {authToken}
    loadPage={stream.loader}
    likerId={currentUserId() ?? undefined}
    {expandOrigin}
    orderChoice={stream.choice}
    onClose={() => stream.close()}
  />
{/if}

<Modal open={emptyOpen} title={m.reels_viewer_label()} onClose={() => (emptyOpen = false)}>
  <ReelsEmptyState />
</Modal>
