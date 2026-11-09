<script lang="ts">
  /**
   * THE "..." OF SOMEONE ELSE'S PROFILE: report and block, out of the header's way.
   *
   * They used to float alone on a line at the right of the page. They are two separate gestures and
   * stay two entries: a block is private, a report asks a moderator to look. Block keeps its
   * destructive colour inside the menu; an already blocked account reads "Debloquer" in the neutral
   * one. The surface is the app's own (`FloatingSurface`: a sheet on a phone, a popover on a wide
   * window) holding a `MenuList`, the shape every "..." of the form editor already has.
   */
  import { Ban, Ellipsis, Flag, ShieldOff } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
  import MenuList from '$lib/components/ui/MenuList.svelte';
  import { opensAsSheet } from '$lib/components/ui/floatingSurface';
  import type { MenuListSection } from '$lib/components/ui/menuList';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The reader has blocked this person: the block entry then lifts it. */
    blocked: boolean;
    /** A block or unblock is in flight: the menu does not open a second one. */
    busy?: boolean;
    onReport: () => void;
    onBlockToggle: () => void;
  }

  let { blocked, busy = false, onReport, onBlockToggle }: Props = $props();

  let open = $state(false);
  let asSheet = $state(false);
  let anchor = $state<HTMLElement | null>(null);

  const sections = $derived<MenuListSection[]>([
    {
      items: [
        { key: 'report', label: m.profile_report_btn(), Icon: Flag },
        blocked
          ? { key: 'block', label: m.profile_unblock_btn(), Icon: ShieldOff }
          : { key: 'block', label: m.profile_block_btn(), Icon: Ban, danger: true },
      ],
    },
  ]);

  function toggle() {
    if (open) {
      open = false;
      return;
    }
    asSheet = opensAsSheet();
    open = true;
  }

  function select(key: string) {
    open = false;
    if (key === 'report') onReport();
    else if (!busy) onBlockToggle();
  }
</script>

<span bind:this={anchor} class="inline-flex shrink-0">
  <Button
    variant="secondary"
    icon
    class="min-h-11 w-11"
    onclick={toggle}
    aria-label={m.profile_more_actions()}
    title={m.profile_more_actions()}
    aria-haspopup="menu"
    aria-expanded={open}
    data-testid="profile-overflow"
  >
    <Ellipsis size={16} class="shrink-0" aria-hidden="true" />
  </Button>
</span>

<FloatingSurface
  {open}
  {asSheet}
  {anchor}
  label={m.profile_more_actions()}
  popoverWidth="content"
  onClose={(refocus) => {
    open = false;
    if (refocus) anchor?.querySelector('button')?.focus();
  }}
>
  <div class="min-w-52">
    <MenuList {sections} label={m.profile_more_actions()} onSelect={select} />
  </div>
</FloatingSurface>
