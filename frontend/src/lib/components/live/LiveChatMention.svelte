<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { peekUserDisplayName, resolveUserDisplayName } from '$lib/utils/users/displayName';

  /**
   * ONE MENTION IN A LIVE CHAT LINE (owner, 2026-11-09): the same amber chip as every other surface
   * (`MessageMentionChip`), tapped to open the profile - but a `<span role="link">`, NOT a button.
   * A line the viewer may report or hide is itself one button (`LiveChatPanel`), and a button inside
   * a button is not HTML; the tap is stopped here so it opens the profile rather than the line's
   * actions. The name is resolved by the chip, as `MessageMentionChip` does, never guessed from the id.
   */
  interface Props {
    userId: string;
  }

  let { userId }: Props = $props();

  /** `null` while the name is not known YET, which is not the same as knowing there is none. */
  let resolved = $state<string | null>(null);

  $effect(() => {
    resolved = peekUserDisplayName(userId);
    void resolveUserDisplayName(userId).then((name) => {
      if (name) resolved = name;
    });
  });

  function openProfile(e: Event) {
    e.stopPropagation();
    e.preventDefault();
    console.debug(`[LIVE_CHAT] mention of ${userId.slice(0, 8)} opened`);
    void goto(resolve(`profile/${userId}`));
  }
</script>

<span
  role="link"
  tabindex="0"
  onclick={openProfile}
  onkeydown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') openProfile(e);
  }}
  class="live-chat-mention cursor-pointer rounded-full px-1 align-baseline font-semibold outline-none focus-visible:ring-2 focus-visible:ring-white"
  data-live-chat-mention={userId}
>
  @<EmojiText text={resolved ?? ''} />
</span>

<style>
  /* Over a live the picture is the video, never the theme's surface: the chip is a fixed amber on
     the dark scrim, whatever the theme (as `.live-chat-glass` is a fixed glass). */
  .live-chat-mention {
    background: color-mix(in srgb, var(--color-cn-yellow) 22%, transparent);
    color: var(--color-cn-yellow);
  }
  .live-chat-mention:hover {
    background: color-mix(in srgb, var(--color-cn-yellow) 34%, transparent);
  }
</style>
