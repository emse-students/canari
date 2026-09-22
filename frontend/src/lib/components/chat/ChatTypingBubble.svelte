<script lang="ts">
  /**
   * "Someone is typing", rendered as a bubble at the foot of the THREAD rather than as a strip
   * above the composer.
   *
   * WHY IT MOVED (user, 2026-09-22). Above the composer it was a band that appeared and disappeared
   * under the conversation, so the thread's last messages slid out of view and back every time
   * somebody touched their keyboard - *"suivre les mouvements de maniere fluide plutot que de cacher
   * involontairement des morceaux de l'interface"*. In the thread it is just another row: it grows
   * the list, the pane follows its own bottom exactly as it does for a message, and nothing is ever
   * covered. It is also what the reference apps do, and it puts the fact where the reader is already
   * looking.
   *
   * ONE BUBBLE, HOWEVER MANY PEOPLE. A bubble per typer turns a lively group into a wall of dots,
   * and the count is the part a reader does not need: WHO is typing is carried by the avatars, and
   * the names are in the live region for anyone who cannot see them. Past three avatars the column
   * would be wider than the bubble, so the rest become a count.
   *
   * THE LIVE REGION IS NOT HERE. It is the permanent `.chat-typing-indicator` wrapper in
   * `ChatArea`, because a `role="status"` element created at the moment it gains text is announced
   * unreliably - assistive technology has to be observing the region BEFORE the mutation. This
   * component only supplies the text for it to read.
   */
  import Avatar from '../shared/Avatar.svelte';

  interface Props {
    /** The people currently typing, already filtered of the reader themselves. */
    userIds: string[];
    /** The localized prose ("X ecrit...") - rendered for assistive tech, never drawn. */
    label: string;
  }

  const { userIds, label }: Props = $props();

  /** Avatars are the only thing identifying the typers on screen, and a column of them is not one. */
  const MAX_AVATARS = 3;
  const shown = $derived(userIds.slice(0, MAX_AVATARS));
  const overflow = $derived(Math.max(0, userIds.length - MAX_AVATARS));
</script>

<div class="flex w-full justify-start gap-2.5">
  <!-- `min-w-8` IS THE ALIGNMENT, and it is measured, not guessed. `ChatMessageGroups` gives a
       received message a FIXED 2rem column holding a 1.5rem avatar, so its bubble starts 42px from
       the row's left edge. Sized to its own avatar this column was 24px and the bubble landed at
       34px - 8px left of every message above it, which reads as a wobble. The minimum restores the
       shared edge for one avatar and still lets the column grow when several people type. -->
  <div class="flex min-w-8 shrink-0 -space-x-2.5 self-end pb-1">
    {#each shown as userId (userId)}
      <span class="inline-flex rounded-full ring-2 ring-(--chat-thread-ground)">
        <Avatar {userId} size="sm" />
      </span>
    {/each}
    {#if overflow > 0}
      <span
        class="bg-bubble-in text-text-muted text-2xs inline-flex h-8 w-8 items-center justify-center rounded-full font-bold ring-2 ring-(--chat-thread-ground)"
        aria-hidden="true"
      >
        +{overflow}
      </span>
    {/if}
  </div>

  <div
    class="bg-bubble-in rounded-bubble flex w-fit items-center gap-1 px-3.5 py-3"
    aria-hidden="true"
  >
    <span class="bg-text-muted h-1.5 w-1.5 animate-bounce rounded-full" style="animation-delay:0ms"
    ></span>
    <span
      class="bg-text-muted h-1.5 w-1.5 animate-bounce rounded-full"
      style="animation-delay:150ms"
    ></span>
    <span
      class="bg-text-muted h-1.5 w-1.5 animate-bounce rounded-full"
      style="animation-delay:300ms"
    ></span>
  </div>

  <!-- The text the live region above reads. `sr-only` is CLIPPED, not removed, so it is still
       rendered - which is what keeps `.chat-typing-indicator`'s `innerText` readable by the
       cross-client rig, whose only hook on this indicator it is. -->
  <span class="sr-only">{label}</span>
</div>
