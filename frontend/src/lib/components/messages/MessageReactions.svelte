<script lang="ts">
  import EmojiText from '../shared/EmojiText.svelte';
  import ReactorsPanel from '$lib/components/shared/ReactorsPanel.svelte';
  import { reactorsTrigger } from '$lib/actions/reactorsTrigger';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Emoji-keyed map of user IDs who have reacted with each emoji. */
    groupedReactions: Record<string, string[]>;
    /** When true, aligns the reaction row to the right (own messages). */
    isOwn?: boolean;
    /** ID of the current user, used to highlight their own reactions. */
    currentUserId?: string;
    /** Called when the user clicks a reaction badge to toggle their own reaction. */
    onReact?: (emoji: string) => void;
  }

  let { groupedReactions = {}, isOwn = false, currentUserId, onReact }: Props = $props();

  /**
   * THE NAMES WERE ONLY EVER IN A `title`, WHICH IS NOTHING ON A TOUCH SCREEN.
   *
   * Reported through the user on 2026-09-18: *"on me dit qu'il n'y a pas de moyen de voir qui a mis
   * quelle reaction dans les groupes."* The data was already here - `groupedReactions` maps an emoji
   * to the ids that chose it - and this row resolved those ids to first names and handed them to the
   * native tooltip. A phone draws no tooltip, and in a DM nobody needs one because there are two
   * people; in a group the badge was a count with no roster behind it.
   *
   * **POSTS HAD ALREADY ANSWERED THIS QUESTION, SO THE ANSWER IS A COMPONENT AND NOT A DESIGN.**
   * `ReactorsPanel` is the panel the posts feed opens on its own badges, extracted so the two cannot
   * drift: one placement, one set of dismissals, one name resolver. Growing a second one here would
   * have been the third copy of the eight lines `userDisplayNames` exists to end.
   */
  let openEmoji = $state<string | null>(null);
  let anchorEl = $state<HTMLElement | null>(null);
  const panelId = $props.id();

  function openPanel(emoji: string, anchor: HTMLElement) {
    anchorEl = anchor;
    openEmoji = emoji;
  }

  function closePanel() {
    openEmoji = null;
    anchorEl = null;
  }

  /**
   * A MESSAGE WITH MANY KINDS OF REACTION SHOWS ITS MOST CHOSEN ONES AND A COUNT OF THE REST.
   *
   * Asked by the user on 2026-09-28, pointing at Messenger: the row took too much of the thread.
   * The cap is a DECLARED one - a `+N` chip names exactly how many kinds are folded and a tap
   * unfolds them all - which is what the silent `max-h` clip described below never did.
   * `+1` would cost the width of the chip it hides, so a row of VISIBLE_KINDS + 1 is drawn whole.
   */
  const VISIBLE_KINDS = 4;
  let expanded = $state(false);

  /** Emoji ranked by how many people chose them; `sort` is stable, so ties keep arrival order. */
  const ranked = $derived(
    Object.entries(groupedReactions).sort(([, a], [, b]) => b.length - a.length)
  );
  const folds = $derived(!expanded && ranked.length > VISIBLE_KINDS + 1);
  const shown = $derived(folds ? ranked.slice(0, VISIBLE_KINDS) : ranked);
</script>

{#if Object.keys(groupedReactions).length > 0}
  <!--
    NOTHING IS CLIPPED HERE, AND THAT USED TO BE FALSE IN SILENCE.
    This row carried `max-h-[5.5rem] overflow-hidden`: 88px of box for content that grows with the
    number of DISTINCT emoji on a message. Measured on A1 (Mi 9T, 436 x 945) on 2026-09-14 by
    injecting chips into the live row: at 37 distinct reactions the content stood 184px and the box
    still 88, so 21 chips were drawn and SIXTEEN simply did not exist on screen - no half-cut chip
    betraying the fold, no "+16", no scroll. A deliberate cap shows a count; this one showed nothing,
    which is how it survived unnoticed.
    The number was never a decision either: it was `4.75rem` with no comment, and became `5.5rem`
    inside a commit about the media lightbox. So it is removed rather than tuned. What keeps the row
    short now is `VISIBLE_KINDS` and its `+N` chip, a fold that SAYS what it folds; once unfolded the
    row wraps, and a message with forty distinct reactions is tall.
  -->
  <!--
    ON THE BUBBLE, NOT UNDER IT (user, 2026-10-01, pointing at Messenger: *"reaction apposee au
    message plutot qu'en dessous"*). The row is pulled up over the bubble's bottom edge (`-mt-1.5`,
    6px - at 10px a pill crowded the last line of text, user 2026-10-01),
    on the side the bubble is aligned to, and each chip wears a ring in the thread's own ground
    (`--chat-thread-ground`) - the gap that makes a sticker read as laid ON the bubble rather than
    cut into it. `relative z-1` lifts it above the bubble it overlaps.
  -->
  <div
    class="relative z-1 -mt-1.5 flex w-full max-w-[min(100%,38rem)] flex-wrap content-start gap-1 px-1.5 pb-0.5 {isOwn
      ? 'justify-end'
      : 'justify-start'}"
    role="group"
    aria-label={m.msg_reactions_label()}
  >
    {#each shown as [emoji, users] (emoji)}
      <!-- Check whether the current user has reacted with this emoji. -->
      {@const hasReacted = currentUserId ? users.includes(currentUserId) : false}

      <button
        type="button"
        class="text-2xs flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 shadow-sm ring-2 ring-(--chat-thread-ground) transition-all duration-200 outline-none focus-visible:ring-amber-500/50 active:scale-95 {hasReacted
          ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
          : 'text-text-muted bg-cn-surface hover:text-text-main'}"
        onclick={(e) => {
          e.stopPropagation(); // Prevent opening message info when clicking a reaction badge.
          onReact?.(emoji);
        }}
        use:reactorsTrigger={{
          open: (anchor) => openPanel(emoji, anchor),
          close: closePanel,
        }}
        aria-pressed={hasReacted}
        aria-describedby={openEmoji === emoji ? panelId : undefined}
        aria-label={users.length === 1
          ? m.msg_reaction_aria_label_one({ emoji })
          : m.msg_reaction_aria_label({ emoji, count: users.length })}
      >
        <span class="text-sm leading-none"><EmojiText text={emoji} /></span>
        {#if users.length > 1}
          <span class="font-bold">{users.length}</span>
        {/if}
      </button>
    {/each}
    {#if folds}
      <button
        type="button"
        class="text-2xs text-text-muted hover:text-text-main bg-cn-surface flex shrink-0 items-center rounded-full px-1.5 py-0.5 font-bold shadow-sm ring-2 ring-(--chat-thread-ground) transition-all duration-200 outline-none focus-visible:ring-amber-500/50 active:scale-95"
        onclick={(e) => {
          e.stopPropagation(); // Same reason as a reaction chip: this is not a tap on the message.
          expanded = true;
        }}
        aria-label={m.msg_reactions_show_more({ count: ranked.length - VISIBLE_KINDS })}
      >
        +{ranked.length - VISIBLE_KINDS}
      </button>
    {/if}
  </div>
{/if}

<ReactorsPanel
  anchor={anchorEl}
  id={panelId}
  emoji={openEmoji}
  userIds={openEmoji ? (groupedReactions[openEmoji] ?? []) : []}
  onClose={closePanel}
/>
