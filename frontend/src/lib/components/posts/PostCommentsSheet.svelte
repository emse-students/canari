<script lang="ts">
  import type { Snippet } from 'svelte';
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import Modal from '$lib/components/shared/Modal.svelte';
  import PostAuthorAvatar from './PostAuthorAvatar.svelte';
  import { POST_MARKDOWN_RENDERERS } from './postMarkdownRenderers';
  import type { PostEntity } from '$lib/posts/api';
  import { postAuthorName } from '$lib/posts/postAuthorName';
  import { preprocessPostMarkdown } from '$lib/utils/posts/postMarkdown';
  import { m } from '$lib/paraglide/messages';

  /**
   * A POST'S COMMENTS, FULL SCREEN ON A PHONE AND A DIALOG ON A LARGER SCREEN (user, 2026-10-21): a
   * short reminder of the post under the title, the thread scrolling in the height left, and the
   * box PINNED above the keyboard - `Modal`'s `phoneFullScreen` is the lever for it, since its
   * overlay already follows the space the keyboard leaves, so a body laid out as a scroll region plus
   * a footer needs nothing computed here (`PostComments`, `h-full min-h-0 flex-col`).
   *
   * The back gesture, Escape, the backdrop and the close button all close it (`Modal`'s history
   * entry); the thread is the caller's, given as `children`, so the card keeps its one write path.
   */
  interface Props {
    open: boolean;
    /** The post, for the reminder under the title. */
    post: PostEntity;
    onClose: () => void;
    children: Snippet;
  }

  let { open, post, onClose, children }: Props = $props();
</script>

<Modal {open} title={m.post_comments_sheet_title()} {onClose} phoneFullScreen maxWidth="max-w-xl">
  <!-- The reminder: who published the post and the start of it, so the thread is read against it. -->
  <div class="border-cn-border flex shrink-0 items-start gap-2.5 border-b px-4 py-2.5 sm:px-5">
    <span class="mt-0.5 shrink-0"><PostAuthorAvatar {post} size="sm" /></span>
    <div class="min-w-0">
      <p class="text-text-main truncate text-xs font-bold">{postAuthorName(post)}</p>
      {#if post.markdown}
        <div
          class="post-markdown text-text-muted line-clamp-2 text-xs leading-snug wrap-break-word [&_p]:m-0 [&_p]:inline"
        >
          <SvelteMarkdown
            source={preprocessPostMarkdown(post.markdown)}
            renderers={POST_MARKDOWN_RENDERERS}
            options={{ gfm: true, breaks: true }}
          />
        </div>
      {/if}
    </div>
  </div>
  <div class="min-h-0 flex-1">
    {@render children()}
  </div>
</Modal>
