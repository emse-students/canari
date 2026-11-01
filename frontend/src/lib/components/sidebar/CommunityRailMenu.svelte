<script lang="ts">
  import { CheckCheck } from '@lucide/svelte';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { portal } from '$lib/actions/portal';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { m } from '$lib/paraglide/messages';

  /**
   * The menu a community icon of the rail opens: a long press under a finger, a right click with a
   * mouse, the Menu key from the keyboard (Discord's, user 2026-10-13). It carries ONE action today,
   * "Marquer tout comme lu"; it is a menu rather than a button so the next community action has a
   * place to go that the same three gestures already reach.
   *
   * Portalled for the reason `PostActionsMenu` gives: the rail sits inside the drawer and the sidebar,
   * and a transform on any ancestor would trap the panel's z-index.
   */
  interface Props {
    /** The rail icon the menu belongs to: it is placed against it, and a click on it is not "outside". */
    anchor: HTMLElement;
    /** The community's name, for the menu's accessible label. */
    communityName: string;
    /** Whether any salon of the community is unread here: the action is offered only then. */
    hasUnread: boolean;
    /** "Marquer tout comme lu" was picked. */
    onMarkRead: () => void;
    /** The menu closes: an action ran, Escape, or a click outside. */
    onClose: () => void;
  }

  let { anchor, communityName, hasUnread, onMarkRead, onClose }: Props = $props();

  let menuEl: HTMLDivElement | null = $state(null);

  $effect(() => {
    if (!menuEl) return;
    return bindFixedPopover(menuEl, { anchor: () => anchor, offset: 4 });
  });

  // The keyboard lands in the menu: a menu opened by the Menu key and left unfocused is unreachable.
  $effect(() => {
    menuEl?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  });

  /** Same row box as the post menu, so the two menus read as one family. */
  const ROW =
    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors';
</script>

<div
  bind:this={menuEl}
  use:portal
  use:clickOutside={{ enabled: true, callback: onClose, ignore: () => anchor }}
  role="menu"
  tabindex="-1"
  aria-label={m.sidebar_community_menu_label({ name: communityName })}
  data-community-menu
  class="glass-chrome border-cn-border fixed z-(--z-popover) flex w-56 flex-col gap-0.5 overflow-auto rounded-xl p-1.5"
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      // Read BEFORE closing: the parent drops the menu's state on close, and the prop with it.
      const opener = anchor;
      onClose();
      opener.focus();
    }
  }}
>
  <!-- `aria-disabled`, not `disabled`: a disabled button cannot take focus, and a menu whose only
       item is unfocusable leaves a keyboard user nowhere. Greyed and inert, as Discord's is. -->
  <button
    type="button"
    role="menuitem"
    aria-disabled={!hasUnread}
    onclick={() => {
      if (!hasUnread) return;
      onClose();
      onMarkRead();
    }}
    class="{ROW} {hasUnread
      ? 'text-text-main hover:bg-amber-500/10 hover:text-amber-600'
      : 'text-text-muted cursor-not-allowed opacity-60'}"
  >
    <CheckCheck size={16} strokeWidth={2.5} aria-hidden="true" />
    {m.sidebar_community_mark_read()}
  </button>
</div>
