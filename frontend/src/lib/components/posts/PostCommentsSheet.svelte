<script lang="ts">
  import type { Snippet } from 'svelte';
  import CommentsDrawer from '$lib/components/shared/CommentsDrawer.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { phoneViewport } from '$lib/stores/phoneViewport.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * A POST'S COMMENTS: THE SHARED DRAWER ON A PHONE, A DIALOG ON A LARGER SCREEN (user, 2026-10-23,
   * phones only). On a phone the thread rises over the interface in `CommentsDrawer` - the very
   * component a CanaReel's comments open in, with its short entrance, its drag down to close and its
   * Back entry - and NOTHING is drawn above the thread: the quoted reminder of the post that used to
   * sit under the title is gone (it was empty of text for a post without any). From `md` up it is
   * the same dialog it was, minus that reminder.
   *
   * The thread is the caller's, given as `children`, so the card keeps its one write path, its
   * report dialog and its draft. Mounted only while open, so the box takes its draft back on every
   * opening. The drawer's history entry and `Modal`'s both close on the back gesture.
   */
  interface Props {
    open: boolean;
    onClose: () => void;
    children: Snippet;
  }

  let { open, onClose, children }: Props = $props();
</script>

{#if open && phoneViewport()}
  <CommentsDrawer scrim label="post" {onClose}>
    {@render children()}
  </CommentsDrawer>
{:else}
  <Modal
    open={open && !phoneViewport()}
    title={m.post_comments_sheet_title()}
    {onClose}
    phoneFullScreen
    maxWidth="max-w-xl"
  >
    <div class="min-h-0 flex-1">
      {@render children()}
    </div>
  </Modal>
{/if}
