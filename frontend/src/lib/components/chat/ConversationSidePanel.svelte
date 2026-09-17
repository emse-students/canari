<script lang="ts">
  import SidePanel from '../shared/SidePanel.svelte';
  import type { Snippet } from 'svelte';

  interface Props {
    /** Whether the panel is showing. `MainChatPage` owns WHICH one panel that is. */
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
  THE CHAT PAGE'S BINDING OF THE SHARED PANEL, AND THE ONE THING IT DECIDES IS `column`.

  Everything this shell does - the scrim, Escape, the header, the close button, the single container
  context the children read their width from - is `SidePanel`, and was moved there on 2026-09-17 so
  the community settings could stop being a fourth shape for the same idea.

  What did NOT move is the answer to "does this panel join a row of cards at `xl`", because that is a
  fact about the HOST rather than about the panel. `MainChatPage` lays its cards out in a flex row
  with a place for this one, so `position: static` produces a column there. The sidebar does not, so
  the panel it opens leaves `column` false. Naming that here, once, is why every caller in this
  directory can keep passing what it always passed.
-->
<SidePanel {open} {title} {onClose} column {actions}>
  {@render children()}
</SidePanel>
