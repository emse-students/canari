<script lang="ts">
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import { X } from '@lucide/svelte';
  import { fade, fly } from 'svelte/transition';
  import { portalWhile } from '$lib/actions/portal';
  import { isOverlayLayout, onViewportChange, OVERLAY_LAYOUT_QUERY } from '$lib/utils/viewport';
  import { m } from '$lib/paraglide/messages';
  import type { Snippet } from 'svelte';

  interface Props {
    /** Whether the panel is showing. The parent owns WHICH one panel that is. */
    open: boolean;
    /** The panel's heading, already localized. */
    title: string;
    /** Closes the panel. On a phone this must also unwind the history entry the parent pushed. */
    onClose: () => void;
    /**
     * Whether this panel JOINS a row of cards at `xl` instead of staying a drawer.
     *
     * It is a statement about the HOST, not about the panel: `position: static` only produces a
     * column where the parent is a flex row with a place for one. The chat page is; the sidebar,
     * which covers the whole app, is not - so a panel opened from there leaves this false and keeps
     * the drawer at every width. Defaulting to false means a new host gets the shape that works
     * anywhere, and opts in once it has measured that it has a row to give.
     */
    column?: boolean;
    /** Controls in the header, placed before the close button (a search icon, a menu). */
    actions?: Snippet;
    /** The panel's body. Scrolls on its own; the header does not move with it. */
    children: Snippet;
  }

  let { open, title, onClose, column = false, actions, children }: Props = $props();

  /**
   * Whether the viewport is one where a panel is a drawer (below `xl`). Followed, not read once: a
   * rotation or a resized window across 1280px turns a column into a drawer and back.
   */
  let overlay = $state(isOverlayLayout());
  $effect(() => {
    return onViewportChange(OVERLAY_LAYOUT_QUERY, (narrow) => (overlay = narrow));
  });

  /**
   * A DRAWER HAS TO LEAVE THE PAGE; A COLUMN HAS TO STAY IN IT. Same sentence, both halves.
   *
   * `.page-scroll-wrap` carries `will-change: transform` for the swipe-between-tabs gesture, which
   * makes it BOTH a stacking context and the containing block for every `position: fixed` inside it
   * - `app.css` says so where the layer ladder is declared, and ends with the rule this follows:
   * anything that must escape a page entirely has to be PORTALLED to the body. A panel written in a
   * page is therefore laid out against `<main>`, between the header and the bottom bar, and is
   * painted under both of them however high its rung is, because its rung is only compared with its
   * siblings inside that wrapper.
   *
   * THE STATUS BAR IS THE OTHER HALF OF THE SAME FACT (owner, 2026-11-04, iPhone: ~70 pt of blank
   * above "Group management"). The page wrapper sits inside `.app-shell`, which pads its top by
   * `--safe-area-inset-top`, so a drawer left IN the page started BELOW the status bar and its header
   * added the same inset again: the inset was applied twice, by the shell and by the header. A drawer
   * is portalled whatever the host, so it is laid out against the window and the header is the ONE
   * owner of the inset (`.side-panel-header`).
   *
   * IT WAS INVISIBLE UNTIL A PANEL OPENED FROM THE SIDEBAR, and then until the status bar was
   * measured: the conversation panels live on a screen that hides `MobileHeader` and `BottomNav`
   * (`isMobileConvoOpen`), which hid the bottom half of the mismatch but never the top.
   *
   * Only a COLUMN that is at `xl` stays: it is a flex SIBLING of the chat cards, and a node moved to
   * `<body>` has no row left to join. Below `xl` every panel is a drawer, so every panel leaves.
   */
  const escapes = $derived(!column || overlay);
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
  ONE SHAPE FOR EVERY PANEL THAT DESCRIBES SOMETHING, AND ONE OF THEM OPEN AT A TIME.

  Before this there were THREE models for the same idea inside a conversation, which is what the
  user reported: "Membres" added a column beside the thread and narrowed it, "Medias, liens et
  fichiers" drew a portalled `fixed inset-0` sheet over it with a scrim, and "Parametres du canal"
  opened a modal. Three behaviours for three things that are all "show me more about this
  conversation", so the answer to "where does this appear" depended on which button was pressed.

  The model kept is the one the user named as right - the reference's, and Canari's own members
  column: a card that JOINS the row of cards rather than covering it (*"un blob qui s'ajoute a cote
  (mais comme les autres blocs, avec les coins arrondis etc) au lieu de par dessus. On laisse cette
  histoire de par dessus pour la navbar"*).

  BELOW `xl` IT IS STILL A DRAWER, and that is not a compromise: a phone has no width to give a
  second column, and the members panel already made exactly this split.

  IT IS A SHARED SHELL RATHER THAN A CHAT ONE, since 2026-09-17. The community settings were the
  FOURTH model for the same idea - a modal, over everything, opened from the sidebar - and the user
  asked for them to read like the conversation's (*"on pourrait avoir quelque chose de similaire aux
  parametres des conversations"*). What they could NOT take is the column: `position: static` needs
  a row with a place for it, and the sidebar has none. So the column became `column`, an opt-in the
  host makes because only the host knows, and everything else here - the scrim, Escape, the header,
  the close button, the one container context - is shared rather than copied a fourth time.

  IT IS ONE INSTANCE AND NOT TWO. Rendering a desktop card and a mobile drawer as separate branches
  would mount `children` TWICE - two copies of the media panel, two decrypt passes, two of every
  request its content makes. The chrome is the only thing that differs, so the chrome is what the
  media query moves, in `.side-panel`.
-->
{#if open}
  <!-- The scrim belongs to the drawer, so it exists only where the drawer does. A panel that never
       becomes a column is always a drawer, and always owes one. -->
  <button
    type="button"
    class="fixed inset-0 z-(--z-side-panel-scrim) bg-black/40 {column ? 'xl:hidden' : ''}"
    aria-label={m.chat_panel_close_label()}
    onclick={onClose}
    use:portalWhile={escapes}
    use:coversScreen={escapes}
    transition:fade={{ duration: 180 }}
  ></button>

  <aside
    class="side-panel bg-cn-surface flex flex-col {column ? 'side-panel-column' : ''}"
    use:portalWhile={escapes}
    use:coversScreen={escapes}
    transition:fly={{ x: 320, duration: 220 }}
  >
    <div
      class="side-panel-header border-cn-border flex shrink-0 items-center justify-between gap-2 border-b px-(--side-panel-inset) pb-3"
    >
      <h2 class="text-text-main truncate text-base font-bold">{title}</h2>
      <div class="flex shrink-0 items-center gap-1">
        {#if actions}{@render actions()}{/if}
        <button
          type="button"
          onclick={onClose}
          class="ui-icon-button text-text-muted hover:text-text-main rounded-xl transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={m.common_close_label()}
        >
          <X size={18} />
        </button>
      </div>
    </div>

    <!--
      THE ONE PLACE THE PANEL SAYS IT IS A CONTAINER, AND EVERY CHILD READS ITS WIDTH FROM HERE.

      The panel's width is NOT a function of the window: measured 2026-09-16 against this app's own
      CSS, it is 320px at a 1400px viewport (the column) and 448px at 1000px (the drawer) - so a
      `sm:` or `md:` variant written inside it asks the wrong box how much room there is, and asks it
      backwards, since the widest window gives the NARROWEST panel. It cost the rename row: at
      1400px `sm:flex-row` was on, the row needed 341px in 230px of card, and the `Valider` button
      stood 66px outside a panel that clips - a control nobody could see or press on a desktop.

      So the children write `@md:`, and `sidePanelWidth.test.ts` holds them to it. `@md` is 28rem,
      which is the drawer's `max-width` FROM 768px. Below 768px the drawer is the whole screen and
      has no cap, so on a wide phone or in landscape (up to 767px) the container is wider than 28rem
      and the `@md` side-by-side forms apply there too: intended - the room is real, and the forms
      only ever needed 28rem of it.

      SAFE HERE ONLY BECAUSE EVERYTHING FULL-SCREEN INSIDE THIS PANEL IS PORTALLED. `container-type:
      inline-size` makes this div the containing block for `position: fixed` descendants; the invite
      `Modal` and the media `FullScreenViewer` both `use:portal` out to `body`, so none of them is a
      descendant by the time it is painted. A future panel child that draws a fixed overlay IN PLACE
      would be positioned against this box instead of the window.
    -->
    <div class="@container min-h-0 flex-1 overflow-y-auto">{@render children()}</div>
  </aside>
{/if}
