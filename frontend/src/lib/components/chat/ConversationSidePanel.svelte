<script lang="ts">
  import { X } from '@lucide/svelte';
  import { fade, fly } from 'svelte/transition';
  import { m } from '$lib/paraglide/messages';
  import type { Snippet } from 'svelte';

  interface Props {
    /** Whether the panel is showing. The parent owns WHICH one panel that is. */
    open: boolean;
    /** The panel's heading, already localized. */
    title: string;
    /** Closes the panel. On a phone this must also unwind the history entry the parent pushed. */
    onClose: () => void;
    /** Controls in the header, placed before the close button (a search icon, a menu). */
    actions?: Snippet;
    /** The panel's body. Scrolls on its own; the header does not move with it. */
    children: Snippet;
  }

  let { open, title, onClose, actions, children }: Props = $props();
</script>

<!--
  ESCAPE CLOSES IT, ONCE, FOR EVERY PANEL. Only the group panel used to answer Escape, through a
  `svelte:window` handler inside `ChatHeader` keyed on that component's own `showPanel` - so the
  media sheet and the channel-settings modal each answered it, or did not, by their own rules. One
  shell means one answer.
-->
<svelte:window
  onkeydown={(e) => {
    if (open && e.key === 'Escape') onClose();
  }}
/>

<!--
  ONE SHAPE FOR EVERY CONVERSATION PANEL, AND ONE OF THEM OPEN AT A TIME.

  Before this there were THREE models for the same idea, which is what the user reported: "Membres"
  added a column beside the thread and narrowed it, "Medias, liens et fichiers" drew a portalled
  `fixed inset-0` sheet over it with a scrim, and "Parametres du canal" opened a modal. Three
  behaviours for three things that are all "show me more about this conversation", so the answer to
  "where does this appear" depended on which button was pressed.

  The model kept is the one the user named as right - the reference's, and Canari's own members
  column: a card that JOINS the row of cards rather than covering it (*"un blob qui s'ajoute a cote
  (mais comme les autres blocs, avec les coins arrondis etc) au lieu de par dessus. On laisse cette
  histoire de par dessus pour la navbar"*).

  BELOW `xl` IT IS STILL A DRAWER, and that is not a compromise: a phone has no width to give a
  second column, and the members panel already made exactly this split. What changes is that the
  media panel and the channel settings now make it too, instead of overlaying a desktop with room
  to spare.

  IT IS ONE INSTANCE AND NOT TWO. Rendering a desktop card and a mobile drawer as separate branches
  would mount `children` TWICE - two copies of the media panel, two decrypt passes, two of every
  request its content makes. The chrome is the only thing that differs, so the chrome is what the
  media query moves, in `.conversation-side-panel`.
-->
{#if open}
  <!-- The scrim belongs to the drawer, so it exists only where the drawer does. -->
  <button
    type="button"
    class="fixed inset-0 z-(--z-side-panel-scrim) bg-black/40 xl:hidden"
    aria-label={m.chat_panel_close_label()}
    onclick={onClose}
    transition:fade={{ duration: 180 }}
  ></button>

  <aside
    class="conversation-side-panel bg-cn-surface flex flex-col"
    transition:fly={{ x: 320, duration: 220 }}
  >
    <div
      class="border-cn-border flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3"
    >
      <h2 class="text-text-main truncate text-base font-bold">{title}</h2>
      <div class="flex shrink-0 items-center gap-1">
        {#if actions}{@render actions()}{/if}
        <button
          type="button"
          onclick={onClose}
          class="text-text-muted hover:text-text-main rounded-xl p-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={m.common_close_label()}
        >
          <X size={18} />
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">{@render children()}</div>
  </aside>
{/if}
