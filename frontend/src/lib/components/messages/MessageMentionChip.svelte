<script lang="ts">
  import { resolve } from '$app/paths';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { goto } from '$app/navigation';
  import { peekUserDisplayName, resolveUserDisplayName } from '$lib/utils/users/displayName';

  interface Props {
    userId: string;
    /** Inside the sender's own accent-filled bubble: take its colour, the accent text would vanish. */
    onOwnBubble?: boolean;
  }

  let { userId, onOwnBubble = false }: Props = $props();

  /**
   * `null` while the name is genuinely not known YET, which is not the same as knowing there is
   * none - only the second may be rendered as a word.
   *
   * BOTH USED TO ARRIVE HERE AS `null`, so the chip could not apply the rule its own comment
   * states and rendered the empty string for each: a message mentioning a deleted account read
   * `hey @ can you look at this`. The resolver now answers the unknown-user label for an id the
   * server has said does not exist - a definitive answer, permanent for the session - and `null`
   * only while the question is still open, so nothing here needs a case for it.
   *
   * The chip resolves for itself rather than taking a label from the parser, because the parser
   * runs once per message body and cannot re-render when a name arrives: whatever it guessed on a
   * cold cache was frozen into the message. It used to guess the raw user id, so a mention read
   * `@3f9a1c2b...` until something unrelated happened to warm the cache; seeding a placeholder
   * label instead would only have changed which wrong thing was frozen.
   */
  let resolved = $state<string | null>(null);

  $effect(() => {
    // The synchronous half is a cache READ, so a warm cache paints the name on the first frame and
    // there is no flash at all. Only a real miss reaches the await.
    resolved = peekUserDisplayName(userId);
    void resolveUserDisplayName(userId).then((name) => {
      if (name) resolved = name;
    });
  });

  function openProfile(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    void goto(resolve(`profile/${userId}`));
  }
</script>

<!-- TWO SURFACES, TWO ANSWERS. On the OWN bubble (filled with the accent) the chip names no colour:
     it inherits the bubble's, like a hashtag, because `text-accent-text` there was yellow on yellow
     (owner, 2026-11-17, Android dark: a blank gap where the name is). On any other bubble it keeps
     the accent text. NO TINT in either case: `bg-accent/N` falls back to the SOLID accent on a
     WebView without `color-mix`, which would be yellow on yellow again on an incoming dark bubble. -->
<button
  type="button"
  onclick={openProfile}
  class="{onOwnBubble
    ? ''
    : 'text-accent-text'} inline cursor-pointer align-baseline text-[0.9em] font-semibold hover:underline"
>
  @<EmojiText text={resolved ?? ''} />
</button>
