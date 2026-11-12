<!--
  ONE OVERLAY FOR EVERY MODAL, AND THE POINT IS NOT THE TYPING SAVED.

  Seven modal containers were written out by hand and no two agreed on what a modal IS. They were
  not seven copies of one decision - each had independently decided a different subset of the
  behaviours a modal owes, and the gaps were invisible because every one of them LOOKS like a modal
  when you open it on a desktop:

  | Site | portalled | Escape | outside-click | safe area | order |
  | --- | --- | --- | --- | --- | --- |
  | `AssociationDocumentManager` (x3) | yes | no | yes | no | stack |
  | `ConfirmDialog` | yes | window AND dialog | yes | yes | stack |
  | `PollComposerModal` | no | no | yes | no | stack |
  | `GifPickerModal` | no | no | yes | no | stack |
  | `routes/admin/agenda` | no | no | NO | no | raw `z-50` |

  **THE RAW `z-50` IS THE ONE THAT PROVES THE POINT.** A number picked in isolation landed the
  agenda's reject modal UNDERNEATH a toast and far below every other modal on the page. A component
  cannot pick a number in isolation, and since 2026-11-13 it names no rung either: the modal is
  REGISTERED on the overlay stack when it opens and takes its z-index from the open order, the last
  opened on top (`utils/overlayStack.ts`). A sheet, a modal and a confirmation are the same overlay;
  a dialog opened from a viewer, a picker from a sheet are in front because they opened later.

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
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import type { Snippet } from 'svelte';
  import { fly } from 'svelte/transition';
  import { portal } from '$lib/actions/portal';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';

  import { useOverlayLayer } from '$lib/utils/overlayLayer.svelte';
  import type { GateName } from '$lib/utils/overlayStack';

  interface Props {
    /** Whether the modal is mounted at all. */
    open: boolean;
    /** Called for every dismissal - the scrim, Escape and the system Back. */
    onClose: () => void;
    /**
     * False for a sheet the person must answer (the biometric enrolment gate): it then holds no
     * history entry, so the system Back cannot close it, exactly as `Modal`'s flag of the same name.
     */
    dismissible?: boolean;
    /** The dialog's accessible name. Required: an unnamed dialog is announced as "dialog". */
    label: string;
    /** `alertdialog` when the dialog interrupts to confirm or warn; `dialog` otherwise. */
    role?: 'dialog' | 'alertdialog';
    /** Whether the scrim is tinted. The click target exists either way - see the docblock. */
    scrim?: boolean;
    /** Classes for the PANEL, which is what varies: its width, its padding, its corners. */
    panelClass?: string;
    /** A pinned gate (`GATES_TOP_FIRST`): a fixed place above the whole normal stack, never open order. */
    gate?: GateName;
    children: Snippet;
  }

  let {
    open,
    onClose,
    dismissible = true,
    label,
    role = 'dialog',
    scrim = true,
    panelClass = '',
    gate,
    children,
  }: Props = $props();

  /** Registered while open: the z-index is the open order, the last opened on top (`utils/overlayStack.ts`). */
  const layer = useOverlayLayer(
    () => open,
    'ModalOverlay',
    () => gate
  );

  /**
   * THE SYSTEM BACK IS A DISMISSAL TOO, so an open overlay holds a history entry. None of the seven
   * consumers did, so on a phone one Back closed whatever was UNDER the dialog - the conversation
   * under the poll composer, the page under a confirmation - and left the dialog standing
   * (audit of 2026-10-13, after the message sheet). The scrim and Escape close it through the
   * owner's state; the entry left behind is a ghost the stack crosses without costing a Back.
   */
  bindHistoryOverlay(
    () => open && dismissible,
    () => onClose()
  );

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
      use:coversScreen
      style:z-index={layer.z}
      class="fixed inset-0 flex items-end justify-center p-4 pb-[max(1rem,var(--safe-area-inset-bottom,0px))] sm:items-center {scrim
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
