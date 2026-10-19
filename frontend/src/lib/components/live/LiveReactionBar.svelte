<script lang="ts">
  /**
   * THE FIVE REACTION BUTTONS OF A LIVE (C8): the post reactions' emoji, drawn as Noto SVG. A tap
   * floats at once and joins the tick's burst (`LiveChatSession.tap`); tapping again and again is the
   * point, so a button never disables itself.
   */
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { LIVE_REACTION_KINDS, liveReactionEmoji, liveReactionLabel } from '$lib/live/liveChat';
  import type { LiveReactionKind } from '$lib/live/types';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    onTap(kind: LiveReactionKind): void;
  }

  let { onTap }: Props = $props();
</script>

<div
  class="pointer-events-auto flex flex-col gap-1"
  role="group"
  aria-label={m.live_reactions_label()}
  data-live-reactions
>
  {#each LIVE_REACTION_KINDS as kind (kind)}
    <button
      type="button"
      class="ui-icon-button rounded-full bg-black/40 text-xl outline-none hover:bg-black/60 focus-visible:ring-2 focus-visible:ring-white motion-safe:active:scale-90"
      aria-label={m.live_reaction_send({ name: liveReactionLabel(kind) })}
      title={liveReactionLabel(kind)}
      onclick={() => onTap(kind)}
      data-live-reaction={kind}
    >
      <EmojiText text={liveReactionEmoji(kind)} />
    </button>
  {/each}
</div>
