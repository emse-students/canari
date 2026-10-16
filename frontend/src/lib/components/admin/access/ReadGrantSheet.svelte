<script lang="ts" module>
  /** The last change saved from the sheet, and its inverse. */
  export interface LastChange {
    text: string;
    undo: () => void;
  }
</script>

<script lang="ts">
  /**
   * WHAT ONE PERSON READS, EDITED AS A SHEET: one group of checkboxes per campus.
   *
   * Each box saves the moment it changes, so there is no "Save" here and closing loses nothing -
   * "Done" only closes. `Modal` brings the bottom sheet on a phone, the focus trap, Escape and the
   * back gesture. The focus trap is also why the last change's "Undo" is drawn HERE as well as in
   * the toast: a keyboard cannot leave the sheet to reach the toast. And a failed save is said
   * here, not on the page the sheet covers.
   */
  import { LoaderCircle } from '@lucide/svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { CAMPUS_SCOPES, cellKey } from '$lib/admin/readAccess';
  import {
    CAMPUSES,
    campusLabel,
    formationLabel,
    type Campus,
    type Formation,
  } from '$lib/profile/miconnectProfile';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    open: boolean;
    userId: string;
    name: string;
    /** Keys (`cellKey`) of every cell held, all people included. */
    held: ReadonlySet<string>;
    /** Keys of the cells being written right now. */
    saving: ReadonlySet<string>;
    onToggle: (campus: Campus, formation: Formation | null) => void;
    onClose: () => void;
    /** A failed save or refresh, shown inside the sheet. */
    error?: string | null;
    lastChange?: LastChange | null;
  }

  let {
    open,
    userId,
    name,
    held,
    saving,
    onToggle,
    onClose,
    error = null,
    lastChange = null,
  }: Props = $props();
</script>

<Modal {open} title={m.readaccess_sheet_title({ name })} {onClose}>
  <div class="space-y-5" data-testid="read-grant-sheet">
    <p class="text-text-muted text-sm">{m.readaccess_sheet_hint()}</p>
    {#if error}
      <p class="text-red-err text-sm" role="alert">{error}</p>
    {/if}
    {#if lastChange}
      {@const change = lastChange}
      <div
        class="border-cn-border flex items-center gap-3 rounded-lg border px-3 py-2"
        data-testid="read-grant-last-change"
      >
        <p class="text-text-main min-w-0 flex-1 text-sm">
          <span class="sr-only">{m.readaccess_last_change()} :</span>
          {change.text}
        </p>
        <button
          type="button"
          onclick={change.undo}
          class="text-text-main hover:bg-cn-surface-alt shrink-0 rounded-lg px-3 py-2 text-sm font-bold"
        >
          {m.common_undo_label()}
        </button>
      </div>
    {/if}
    {#each CAMPUSES as campus (campus)}
      <fieldset class="space-y-1">
        <legend class="text-text-main mb-1 text-sm font-semibold">{campusLabel(campus)}</legend>
        <div class="grid grid-cols-2 gap-1">
          {#each CAMPUS_SCOPES as scope (scope ?? '*')}
            {@const key = cellKey(userId, campus, scope)}
            {@const busy = saving.has(key)}
            <label
              class="hover:bg-cn-surface-alt flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm {scope ===
              null
                ? 'col-span-2 font-semibold'
                : ''} {busy ? 'cursor-wait opacity-60' : 'cursor-pointer'}"
            >
              <input
                type="checkbox"
                class="accent-cn-yellow h-4 w-4 shrink-0"
                checked={held.has(key)}
                aria-busy={busy}
                aria-disabled={busy}
                data-cell={key}
                onchange={(e) => {
                  // `aria-disabled`, NOT `disabled`, while it saves: disabling the focused box drops
                  // focus to the page body, behind the sheet. A click during the write is put back,
                  // and the box says why: dimmed, a spinner, "Saving" for a screen reader.
                  if (busy) {
                    e.currentTarget.checked = held.has(key);
                    return;
                  }
                  onToggle(campus, scope);
                }}
              />
              <span class="text-text-main">
                {scope === null ? m.readaccess_whole_campus() : formationLabel(scope)}
              </span>
              {#if busy}
                <LoaderCircle size={14} class="text-text-muted animate-spin" aria-hidden="true" />
                <span class="sr-only">{m.readaccess_saving()}</span>
              {/if}
            </label>
          {/each}
        </div>
      </fieldset>
    {/each}
    <p class="text-text-muted text-xs">{m.readaccess_istp_note()}</p>
  </div>

  {#snippet footer()}
    <Button onclick={onClose} class="w-full sm:w-auto">{m.readaccess_sheet_done()}</Button>
  {/snippet}
</Modal>
