<script lang="ts">
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import CommentAuthorAvatar from './CommentAuthorAvatar.svelte';
  import RevealedAuthorLine from './RevealedAuthorLine.svelte';
  import { POST_MARKDOWN_RENDERERS } from './postMarkdownRenderers';
  import type { PostComment } from '$lib/posts/api';
  import { commentAuthorName, commentRevealedAuthorId } from '$lib/posts/commentAuthor';
  import { preprocessPostMarkdown } from '$lib/utils/posts/postMarkdown';
  import { m } from '$lib/paraglide/messages';

  /**
   * WHAT A CARD SHOWS OF ITS COMMENTS: the newest one, how many there are, and a line to write one.
   * Every tap opens the comment sheet (`PostCommentsSheet`), where the thread is read and written
   * with the box pinned above the keyboard - the card is not a place to hold a conversation.
   *
   * NOTHING IS DRAWN FOR A POST NOBODY HAS COMMENTED ON. A permanent "write a comment" field in every
   * card cost 90 px each (measured on the Mi 9T, 2026-09-14, four posts = 360 px of empty fields);
   * the card's comment icon opens the sheet, which is where a first comment is written.
   */
  interface Props {
    /** The comments held for the post (the feed row's newest few, and whatever was written here). */
    comments: PostComment[];
    /** The server's total, replies included. */
    commentCount: number;
    currentUserId: string;
    /** Opens the sheet; `write` puts the caret in its box. */
    onOpen: (opts: { write: boolean }) => void;
  }

  let { comments, commentCount, currentUserId, onOpen }: Props = $props();

  /** The newest top-level comment: the one a reader opening the post would see first. */
  const latest = $derived(
    comments
      .filter((c) => !c.parentId)
      .reduce<PostComment | null>(
        (best, c) =>
          !best || new Date(c.createdAt).getTime() > new Date(best.createdAt).getTime() ? c : best,
        null
      )
  );

  /** Who wrote the newest comment, when it is anonymous and the server told this reader. */
  const revealedAuthorId = $derived(latest ? commentRevealedAuthorId(latest) : null);

  /** A tap on the comment opens the sheet, except on a link inside it (a mention goes to its profile). */
  function openFromComment(e: MouseEvent) {
    if ((e.target as Element).closest('a')) return;
    onOpen({ write: false });
  }
</script>

{#if comments.length > 0 || commentCount > 0}
  <div
    class="border-t border-black/5 bg-white/30 px-4 pt-2 pb-3 sm:px-5 dark:border-white/10 dark:bg-black/10"
    data-comments-preview
  >
    {#if commentCount > 1}
      <button
        type="button"
        onclick={() => onOpen({ write: false })}
        class="tap-target text-text-muted hover:text-text-main text-2xs mb-1 px-1 py-1 font-bold transition-colors outline-none focus-visible:underline"
      >
        {m.post_show_comments_label({ count: commentCount })}
      </button>
    {/if}

    {#if latest}
      <!-- Not a button: the text may carry links (mentions), and a link inside a button is invalid.
           The "view the comments" line above is the keyboard's way in. -->
      <div
        role="presentation"
        class="mt-1 flex cursor-pointer items-start gap-2.5"
        onclick={openFromComment}
      >
        <span class="mt-0.5 shrink-0"><CommentAuthorAvatar comment={latest} /></span>
        <div class="w-fit max-w-full min-w-0 rounded-3xl bg-black/5 px-3.5 py-2 dark:bg-white/10">
          <span class="text-text-main block text-xs font-bold">
            <EmojiText text={commentAuthorName(latest)} />
          </span>
          {#if revealedAuthorId}
            <RevealedAuthorLine userId={revealedAuthorId} class="text-text-muted mb-0.5" />
          {/if}
          {#if latest.text}
            <div
              class="post-markdown text-text-main line-clamp-2 text-sm leading-snug wrap-break-word [&_p]:m-0 [&_p]:inline"
            >
              <SvelteMarkdown
                source={preprocessPostMarkdown(latest.text)}
                renderers={POST_MARKDOWN_RENDERERS}
                options={{ gfm: true, breaks: true }}
              />
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- The line that opens the sheet with the caret in its box. -->
    <button
      type="button"
      onclick={() => onOpen({ write: true })}
      class="mt-3 flex w-full items-center gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
    >
      <span class="block h-8 w-8 shrink-0"><Avatar userId={currentUserId} fill /></span>
      <span
        class="text-text-muted min-w-0 flex-1 truncate rounded-3xl bg-black/5 px-3.5 py-2.5 text-sm dark:bg-white/10"
      >
        {m.post_comment_placeholder()}
      </span>
    </button>
  </div>
{/if}
