<!--
  ONE OVERLAY FOR EVERY MODAL, AND THE POINT IS NOT THE TYPING SAVED.

  Seven modal containers were written out by hand and no two agreed on what a modal IS. They were
  not seven copies of one decision - each had independently decided a different subset of the
  behaviours a modal owes, and the gaps were invisible because every one of them LOOKS like a modal
  when you open it on a desktop:

  | Site | portalled | Escape | outside-click | safe area | layer |
  | --- | --- | --- | --- | --- | --- |
  | `AssociationDocumentManager` (x3) | yes | no | yes | no | `--z-modal` |
  | `ConfirmDialog` | yes | window AND dialog | yes | yes | `--z-critical` |
  | `PollComposerModal` | no | no | yes | no | `--z-sheet` |
  | `GifPickerModal` | no | no | yes | no | `--z-sheet` |
  | `routes/admin/agenda` | no | no | NO | no | raw `z-50` |

  **THE RAW `z-50` IS THE ONE THAT PROVES THE POINT.** This app has a twenty-rung ladder in
  `app.css` and `50` is not on it: it lands between `--z-page-overlay` (40) and `--z-toast` (60), so
  the agenda's reject modal opened UNDERNEATH a toast and far below every other modal on the page.
  Nobody wrote that; it is what a number picked in isolation does. A component cannot pick a number
  in isolation, which is why `layer` here takes a NAME and the class strings are literals in this
  file - Tailwind cannot build `z-(--z-...)` from a runtime value, and a lookup of literals is the
  one spelling that is both dynamic to the caller and static to the scanner.

  **NOT PORTALLING IS NOT A STYLE CHOICE, IT IS THE GIF PICKER DEFECT.** `position: fixed` resolves
  against the viewport only while NO ancestor establishes a containing block; a `transform`,
  `filter`, `backdrop-filter`, `perspective`, `contain` or `will-change` anywhere above silently
  makes that ancestor the containing block instead. The GIF picker worked in the chat composer (near
  the root) and did weird things in a post's comment box (inside a transformed feed card). So the
  portal is not optional here and there is no prop to turn it off: a modal is anchored to nothing.

  **ESCAPE IS BOUND TWICE, AND ONE OF THE TWO IS NOT REDUNDANT.** `ConfirmDialog` learned this: the
  dialog stops propagation, so a handler only on the window fires exactly while focus is OUTSIDE the
  dialog - which `focusTrap` makes never. Window AND dialog, or Escape works only until the first
  time anybody focuses something.

  **THE SCRIM CAN BE INVISIBLE BUT NEVER ABSENT.** `scrim={false}` drops the dark plate (the user,
  2026-09-13, about the GIF picker: *"pas besoin de fond fonce"*) and keeps the full-bleed
  click-to-close target, because the thing that closes a modal by clicking beside it is the plate,
  not its colour. Removing the colour by removing the element is how a modal becomes uncloseable on
  a phone, where there is no Escape key.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fly } from 'svelte/transition';
  import { portal } from '$lib/actions/portal';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';

  /** Which rung of `app.css`'s ladder this modal sits on. Names, never numbers. */
  type Layer = 'sheet' | 'modal' | 'critical';

  interface Props {
    /** Whether the modal is mounted at all. */
    open: boolean;
    /** Called for every dismissal - the scrim, Escape, and nothing else. */
    onClose: () => void;
    /** The dialog's accessible name. Required: an unnamed dialog is announced as "dialog". */
    label: string;
    /**
     * `sheet` for a picker raised from the composer, `modal` for ordinary content, `critical` for
     * something that must cover a modal already open (a confirmation about it).
     */
    layer?: Layer;
    /** `alertdialog` when the dialog interrupts to confirm or warn; `dialog` otherwise. */
    role?: 'dialog' | 'alertdialog';
    /** Whether the scrim is tinted. The click target exists either way - see the docblock. */
    scrim?: boolean;
    /** Classes for the PANEL, which is what varies: its width, its padding, its corners. */
    panelClass?: string;
    children: Snippet;
  }

  let {
    open,
    onClose,
    label,
    layer = 'modal',
    role = 'dialog',
    scrim = true,
    panelClass = '',
    children,
  }: Props = $props();

  /**
   * The ladder, as literals.
   *
   * Tailwind scans source text, so a class it never sees spelled out is a class it never generates
   * - `z-(--z-${layer})` would compile to nothing and the modal would sit at `auto`. Spelling the
   * three out here is what lets the CALLER be dynamic.
   */
  const LAYER_CLASS: Record<Layer, string> = {
    sheet: 'z-(--z-sheet)',
    modal: 'z-(--z-modal)',
    critical: 'z-(--z-critical)',
  };

  /**
   * Escape closes, and nothing typed inside the modal reaches the app's own shortcuts.
   *
   * `stopPropagation` on the dialog is why the window handler alone is not enough, and why this one
   * function is bound in both places rather than written twice.
   */
  function handleKeydown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
  <div use:portal>
    <!--
      ITEMS-END ON A PHONE, CENTRED FROM `sm` UP. A centred panel on a 375px screen puts its
      controls in the middle of the glass and its top edge under the notch; a sheet rising from the
      bottom puts them under the thumb. The safe-area padding is what keeps the last button clear of
      the home indicator - `ConfirmDialog` was the only one of the seven that had it.
    -->
    <div
      role="presentation"
      class="fixed inset-0 {LAYER_CLASS[
        layer
      ]} flex items-end justify-center p-4 pb-[max(1rem,var(--safe-area-inset-bottom,0px))] sm:items-center {scrim
        ? 'bg-black/40'
        : ''}"
      onclick={(e) => e.target === e.currentTarget && onClose()}
      in:fly={{ duration: 150, opacity: 0 }}
    >
      <div
        {role}
        aria-modal="true"
        aria-label={label}
        tabindex="-1"
        use:focusTrap
        onkeydown={handleKeydown}
        class={panelClass}
        in:fly={{ duration: 200, y: 16 }}
      >
        {@render children()}
      </div>
    </div>
  </div>
{/if}
