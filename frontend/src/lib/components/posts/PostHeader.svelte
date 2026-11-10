<script lang="ts">
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import PostAuthorAvatar from './PostAuthorAvatar.svelte';
  import RevealedAuthorLine from './RevealedAuthorLine.svelte';
  import StudentsOnlyChip from './StudentsOnlyChip.svelte';
  import FollowChip from '$lib/components/follows/FollowChip.svelte';
  import { Pin, Repeat2, Send } from '@lucide/svelte';
  import { timeAgo, exactDate } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';
  import {
    postAuthorHref,
    postAuthorLinkLabel,
    postAuthorName,
    revealedPostAuthor,
  } from '$lib/posts/postAuthorName';
  import { pendingRequests, republishedByText } from '$lib/posts/republication';

  /** Props for the PostHeader component. */
  interface Props {
    /** The post whose author/association and creation time are displayed. */
    post: PostEntity;
    /** Whether "Suivre" is offered beside the publisher; off in the moderation preview. */
    showFollow?: boolean;
  }

  let { post, showFollow = true }: Props = $props();

  /**
   * Who wrote an anonymous post, when the server told this reader (author, moderator, admin): drawn
   * small under "Anonyme", which stays the name (user, 2026-10-24).
   */
  const revealed = $derived(revealedPostAuthor(post));

  /** The post's publisher name - see `postAuthorName`, shared with the media viewer. */
  function getPostAuthorName(): string {
    return postAuthorName(post);
  }

  /**
   * "Republie par X, Y +N" (D38): one card per post, however many associations carry it - on the
   * time's line, "2 h . Republie par BDE" (user, 2026-10-24), not a line of its own. The reader
   * who reposted it reads "vous" first - "Republie par vous et Marie" (WP-F6, owner 2026-11-02).
   */
  const republished = $derived(
    republishedByText(post.republishedBy, post.repostedBy, post.repostedByMe === true)
  );

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
<div class="flex min-w-0 flex-1 items-center gap-3 bg-transparent px-4 py-2.5">
  {#if authorHref}
    <a
      href={authorHref}
      class="focus-visible:ring-accent-icon shrink-0 rounded-full shadow-sm transition-transform duration-200 outline-none hover:scale-105 focus-visible:ring-2"
      aria-label={authorLinkLabel}
    >
      <span class="block h-10 w-10"><PostAuthorAvatar {post} fill /></span>
    </a>
  {:else}
    <span class="shrink-0">
      <span class="block h-10 w-10"><PostAuthorAvatar {post} fill /></span>
    </span>
  {/if}

  <div class="flex min-w-0 flex-1 flex-col justify-center">
    <div class="truncate">
      {#if authorHref}
        <a
          href={authorHref}
          class="text-text-main hover:text-accent-text text-sm font-bold transition-colors outline-none focus-visible:underline"
        >
          <EmojiText text={getPostAuthorName()} />
        </a>
      {:else}
        <span class="text-text-main text-sm font-bold">{getPostAuthorName()}</span>
      {/if}
    </div>
    {#if revealed}
      <RevealedAuthorLine
        userId={revealed.userId}
        fallback={revealed.name}
        class="text-text-muted"
      />
    {/if}
    <div
      class="text-text-muted text-2xs mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 font-medium"
      data-post-time-line
    >
      <span class="shrink-0 opacity-80" title={exactDate(post.publishedAt)}
        >{timeAgo(post.publishedAt)}</span
      >
      {#if post.pinned}
        <!-- A PINNED POST IS A MUTED WORD ON THE TIME'S LINE, as Facebook marks a pinned or sponsored post - no coloured sticker over the card's edge. -->
        <span class="flex shrink-0 items-center gap-1 opacity-80" data-post-pinned>
          <Pin size={12} strokeWidth={2.5} class="shrink-0" aria-hidden="true" />
          {m.post_pinned()}
        </span>
      {/if}
      {#if post.studentsOnly}
        <span class="shrink-0 opacity-80"><StudentsOnlyChip /></span>
      {/if}
      {#if post.feedSuggested}
        <!-- "Suggestion" is a muted word here, as the pinned mark is - no yellow badge over the card's edge (owner, 2026-11-10). -->
        <span class="flex shrink-0 items-center gap-1.5 opacity-80" data-post-suggestion>
          <span aria-hidden="true">&#183;</span>
          {m.suggestion_post_badge()}
        </span>
      {/if}
      {#if showFollow && post.association}
        <!--
          THE LINE IS NOT DIMMED AS A WHOLE: an opacity on a parent cannot be undone by a child, and
          "Suivre" must stay at full strength, so each muted item carries its own `opacity-80`.
          "Suivre" for whoever published this, when the reader does not follow them yet (engagement
          WP-2), a quiet text link on this line and never a button (owner, 2026-11-10). An association
          post offers the association; a personal post its author; an anonymous post nothing (a revealed
          author is never turned into a link); the moderation preview (`showFollow` off) nothing.
        -->
        <FollowChip
          kind="association"
          targetId={post.association.id}
          name={post.association.name}
          dotted
        />
      {:else if showFollow && post.authorId && !post.anonymous}
        <FollowChip kind="user" targetId={post.authorId} name={getPostAuthorName()} dotted />
      {/if}
      {#if republished}
        <!-- One wrapping unit: beside the time and the "Entre etudiants" chip it was squeezed to "Republie par Cl..." on a phone, so it drops to its own line when the three do not fit. -->
        <span
          class="flex max-w-full min-w-0 items-center gap-1.5 opacity-80"
          data-post-republished-unit
        >
          <Repeat2 size={12} strokeWidth={2.5} class="shrink-0" aria-hidden="true" />
          <span class="truncate" data-post-republished-by><EmojiText text={republished} /></span>
        </span>
      {/if}
    </div>
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
