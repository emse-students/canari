<script module lang="ts">
  /**
   * The bar's layout, by CSS alone (owner, 2026-11-19): a column in portrait, where the width is the
   * scarce side, a ROW in landscape (desktop and a phone held sideways), where the height is - five
   * 44 px targets stacked would stand 240 px tall beside the comment field. `shrink-0` keeps the five
   * whole when the field beside them is squeezed.
   */
  export const LIVE_REACTIONS_CLASS =
    'pointer-events-auto flex shrink-0 flex-col gap-1 landscape:flex-row landscape:gap-2';
</script>

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
  class={LIVE_REACTIONS_CLASS}
  role="group"
  aria-label={m.live_reactions_label()}
  data-live-reactions
>
  {#each LIVE_REACTION_KINDS as kind (kind)}
    <button
      type="button"
      class="ui-icon-button bg-cn-scrim/50 hover:bg-cn-scrim/70 rounded-full text-xl outline-none focus-visible:ring-2 focus-visible:ring-white motion-safe:active:scale-90"
      aria-label={m.live_reaction_send({ name: liveReactionLabel(kind) })}
      title={liveReactionLabel(kind)}
      onclick={() => onTap(kind)}
      data-live-reaction={kind}
    >
      <EmojiText text={liveReactionEmoji(kind)} />
    </button>
  {/each}
</div>
