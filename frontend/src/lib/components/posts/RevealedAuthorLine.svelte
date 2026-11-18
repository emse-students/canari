<script lang="ts">
  /**
   * THE SMALL LINE UNDER "ANONYME" THAT NAMES WHO WROTE IT, for the reader the server told (user,
   * 2026-10-24): "Anonyme" stays the name, big, and the real author follows small, linking the
   * profile. One component for the post header, the reel overlay and a comment, so the three draw
   * the same thing. It is mounted ONLY when the server served the id (`revealedPostAuthor`,
   * `commentRevealedAuthorId`) - nothing here decides who may see an author. The same line names
   * the writer under an association's name (`under: 'association'`, decision 11 of
   * moderation-authority), with a pen instead of the mask.
   *
   * The name is resolved from the id (`UserName`), because an anonymous comment stores no name;
   * `fallback` is what a post's own name columns already say, painted until the lookup answers.
   */
  import { PenLine, VenetianMask } from '@lucide/svelte';
  import type { RevealedUnder } from '$lib/posts/postAuthorName';
  import UserName from '$lib/components/shared/UserName.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The author's account, as served to this reader. */
    userId: string;
    /** A name the caller already holds, shown until the id resolves. */
    fallback?: string;
    /** Extra classes - the reel overlay draws it white over its scrim. */
    class?: string;
    /**
     * The link is a 44 px row (the reel overlay, where it is a target of its own on a touch screen,
     * like the author link above it). Not `tap-target`: the name truncates, and the overflow that
     * truncates it would clip that utility's enlarged hit box.
     */
    tall?: boolean;
    /** The name the writer is drawn under: "Anonyme" (the mask) or an association's (a pen). */
    under?: RevealedUnder;
  }

  let {
    userId,
    fallback,
    class: className = 'text-text-muted',
    tall = false,
    under = 'anonymous',
  }: Props = $props();

  const Glyph = $derived(under === 'association' ? PenLine : VenetianMask);
</script>

<span
  class="text-2xs flex min-w-0 items-center gap-1 font-medium {className}"
  title={under === 'association'
    ? m.post_association_writer_hint()
    : m.post_anonymous_revealed_hint()}
  data-revealed-author={userId}
>
  <Glyph size={11} strokeWidth={2.5} class="shrink-0" aria-hidden="true" />
  <span class="sr-only"
    >{under === 'association'
      ? m.post_association_writer_label()
      : m.post_anonymous_revealed_label()}</span
  >
  <UserName {userId} {fallback} class={tall ? 'block min-h-11 truncate leading-11' : 'truncate'} />
</span>
