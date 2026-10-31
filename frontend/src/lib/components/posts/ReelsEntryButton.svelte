<script lang="ts">
  /**
   * THE CANAREELS ENTRY, AN ICON AT THE RIGHT END OF THE FEED'S TAB ROW (user, 2026-10-16, in the
   * spirit of the old IGTV button). A tap goes STRAIGHT INTO the full-screen reel viewer at the
   * newest reel the member may see, whatever tab is open (`reels/allReels.ts`); the viewer covers
   * the whole screen (`coversScreen`) and its close returns to the feed exactly as it was, since the
   * feed never left. It replaces the 2026-10-15 filter bar ("Tous les posts" / "CanaReels"), whose
   * filtered-feed mode is gone (docs/wiki/frontend/modules/reels.md, "The CanaReels entry").
   *
   * The first page is read BEFORE the viewer opens, because an empty viewer is no answer: with no
   * reel yet, a small sheet says so and offers the camera (`ReelsEmptyState`). That page is then
   * the viewer's own first page, not a second request (`reelsAfterFirstPage`).
   */
  import { Clapperboard } from '@lucide/svelte';
  import ReelViewer from '$lib/components/reels/ReelViewer.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import ReelsEmptyState from './ReelsEmptyState.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import { REEL_PAGE, listAllReels, reelsAfterFirstPage } from '$lib/reels/allReels';
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
  let emptyOpen = $state(false);

  async function open() {
    if (opening) return;
    opening = true;
    console.debug('[reels-entry] opening the viewer at the newest reel');
    try {
      const page = await listAllReels(0, REEL_PAGE);
      if (page.length === 0) {
        console.debug('[reels-entry] no reel yet - the empty sheet');
        emptyOpen = true;
        return;
      }
      firstPage = page;
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
      opening = false;
    }
  }
</script>

<button
  type="button"
  data-reels-entry
  aria-label={m.posts_reels_open()}
  title={m.posts_reels_open()}
  aria-haspopup="dialog"
  aria-busy={opening}
  onclick={open}
  class="glass-chrome ui-icon-button text-text-muted hover:text-text-main rounded-full focus-visible:ring-2 focus-visible:ring-amber-500 {opening
    ? 'opacity-60'
    : ''}"
>
  <Clapperboard size={18} aria-hidden="true" />
</button>

{#if firstPage}
  <ReelViewer
    startPost={firstPage[0]}
    {authToken}
    loadPage={reelsAfterFirstPage(firstPage)}
    likerId={currentUserId() ?? undefined}
    onClose={() => (firstPage = null)}
  />
{/if}

<Modal open={emptyOpen} title={m.reels_viewer_label()} onClose={() => (emptyOpen = false)}>
  <ReelsEmptyState />
</Modal>
