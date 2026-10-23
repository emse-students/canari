<script lang="ts">
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import PostAuthorAvatar from './PostAuthorAvatar.svelte';
  import { Clock, Repeat2, Send, VenetianMask } from '@lucide/svelte';
  import { timeAgo, exactDate } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';
  import { postAuthorHref, postAuthorLinkLabel, postAuthorName } from '$lib/posts/postAuthorName';
  import { pendingRequests, republishedByLine } from '$lib/posts/republication';

  /** Props for the PostHeader component. */
  interface Props {
    /** The post whose author/association and creation time are displayed. */
    post: PostEntity;
  }

  let { post }: Props = $props();

  /** True whenever the reader can see WHO published an anonymous post - drives the badge alone. */
  const anonymousBadge = $derived(!!post.anonymous && !!post.authorId);

  /** The post's publisher name - see `postAuthorName`, shared with the media viewer. */
  function getPostAuthorName(): string {
    return postAuthorName(post);
  }

  /** "Republie par X, Y +N" (D38): one card per post, however many associations carry it. */
  const republished = $derived(republishedByLine(post.republishedBy));

  /**
   * "Demande envoyee au nom de X" (D38b): what the reader's associations asked the author of this
   * personal post, still unanswered - shown to the asker only, the server serves it to nobody else.
   */
  const requested = $derived(pendingRequests(post).map((r) => r.name));

  /** Where the publisher links - `postAuthorHref`, shared with the reel viewer; none when hidden. */
  const authorHref = $derived(postAuthorHref(post));
  const authorLinkLabel = $derived(postAuthorLinkLabel(post));
</script>

<!--
  `min-w-0 flex-1` BECAUSE THE ACTION ROW IS THIS HEADER'S SIBLING, NOT ITS OVERLAY.
  `PostCard` lays the two out side by side, so the width left for the name is whatever the buttons
  do not take - which is the only correct answer when the button COUNT varies from one (a reader:
  share) to five (a manager who can also pin, edit, delete and report). Without `min-w-0` a flex
  item refuses to shrink below its content and the `truncate` below never fires.
-->
<div class="flex min-w-0 flex-1 items-center gap-3.5 bg-transparent px-5 py-4">
  {#if authorHref}
    <a
      href={authorHref}
      class="shrink-0 rounded-full shadow-sm transition-transform duration-200 outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-amber-500"
      aria-label={authorLinkLabel}
    >
      <PostAuthorAvatar {post} />
    </a>
  {:else}
    <span class="shrink-0">
      <PostAuthorAvatar {post} />
    </span>
  {/if}

  <div class="flex min-w-0 flex-1 flex-col justify-center">
    <div class="truncate">
      {#if authorHref}
        <a
          href={authorHref}
          class="text-text-main text-sm font-bold transition-colors outline-none hover:text-amber-600 focus-visible:underline dark:hover:text-amber-400"
        >
          <EmojiText text={getPostAuthorName()} />
        </a>
      {:else}
        <span class="text-text-main text-sm font-bold">{getPostAuthorName()}</span>
      {/if}
    </div>
    <div class="text-text-muted text-2xs mt-0.5 flex items-center gap-1.5 font-medium opacity-80">
      <Clock size={12} strokeWidth={2.5} />
      <span title={exactDate(post.publishedAt)}>{timeAgo(post.publishedAt)}</span>
      {#if anonymousBadge}
        <span class="inline-flex items-center gap-1" title={m.post_anonymous_badge_hint()}>
          <VenetianMask size={12} strokeWidth={2.5} />
          {m.post_anonymous_label()}
        </span>
      {/if}
    </div>
    {#if republished}
      <div class="text-text-muted text-2xs mt-0.5 flex min-w-0 items-center gap-1.5 font-medium">
        <Repeat2 size={12} strokeWidth={2.5} class="shrink-0" />
        <span class="truncate">
          <EmojiText
            text={republished.extra > 0
              ? m.post_republished_by_more({
                  names: republished.names.join(', '),
                  count: republished.extra,
                })
              : m.post_republished_by({ names: republished.names.join(', ') })}
          />
        </span>
      </div>
    {/if}
    {#if requested.length > 0}
      <div class="text-text-muted text-2xs mt-0.5 flex min-w-0 items-center gap-1.5 font-medium">
        <Send size={12} strokeWidth={2.5} class="shrink-0" />
        <span class="truncate">
          <EmojiText text={m.post_request_pending({ names: requested.join(', ') })} />
        </span>
      </div>
    {/if}
  </div>
</div>
