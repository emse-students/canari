<script lang="ts">
  /**
   * WHAT ONE PERSON READS, EDITED AS A SHEET: one group of checkboxes per campus.
   *
   * Each box saves the moment it changes (the page offers "Undo" in a toast), so there is no
   * "Save" here and closing loses nothing - "Done" only closes. `Modal` brings the bottom sheet on a
   * phone, the focus trap, Escape and the back gesture.
   */
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
  }

  let { open, userId, name, held, saving, onToggle, onClose }: Props = $props();
</script>

<Modal {open} title={m.readaccess_sheet_title({ name })} {onClose}>
  <div class="space-y-5" data-testid="read-grant-sheet">
    <p class="text-text-muted text-sm">{m.readaccess_sheet_hint()}</p>
    {#each CAMPUSES as campus (campus)}
      <fieldset class="space-y-1">
        <legend class="text-text-main mb-1 text-sm font-semibold">{campusLabel(campus)}</legend>
        <div class="grid grid-cols-2 gap-1">
          {#each CAMPUS_SCOPES as scope (scope ?? '*')}
            {@const key = cellKey(userId, campus, scope)}
            <label
              class="hover:bg-cn-surface-alt flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm {scope ===
              null
                ? 'col-span-2 font-semibold'
                : ''}"
            >
              <input
                type="checkbox"
                class="accent-cn-yellow h-4 w-4 shrink-0"
                checked={held.has(key)}
                aria-busy={saving.has(key)}
                data-cell={key}
                onchange={(e) => {
                  // NOT `disabled` while it saves: disabling the focused box drops focus to the
                  // page body, behind the sheet. A click during the write is put back instead.
                  if (saving.has(key)) {
                    e.currentTarget.checked = held.has(key);
                    return;
                  }
                  onToggle(campus, scope);
                }}
              />
              <span class="text-text-main">
                {scope === null ? m.readaccess_whole_campus() : formationLabel(scope)}
              </span>
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
