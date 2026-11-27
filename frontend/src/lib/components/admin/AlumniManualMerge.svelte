<script lang="ts">
  /**
   * "Rattacher à un autre compte" (D55): the manual merge of one Alumni-created account. The admin
   * searches by name among the accounts the SERVER calls eligible (CAS-linked, no Alumni link, no
   * other open merge), picks one, and writes WHY - 20 to 1000 characters, the server's own bounds,
   * counted on the trimmed text. The button stays disabled until both are there; the server checks
   * again and decides the mode, and MiConnect re-checks both names at the sign-in. Nothing is marked
   * here: `onSubmit` hands the choice to the page, which shows what the duplicate holds first.
   */
  import { Search } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import {
    ALUMNI_MERGE_REASON_MAX,
    ALUMNI_MERGE_REASON_MIN,
    alumniMergeErrorMessage,
    alumniReasonState,
    fetchAlumniMergeTargets,
    type AlumniAccount,
  } from '$lib/profile/alumniMerge';

  interface Props {
    /** The Alumni-created account to attach. */
    duplicate: AlumniAccount;
    /** The page's own request in flight. */
    disabled?: boolean;
    /** The chosen target and the trimmed reason; the page confirms and marks. */
    onSubmit: (target: AlumniAccount, reason: string) => void;
  }

  let { duplicate, disabled = false, onSubmit }: Props = $props();

  let query = $state('');
  let results = $state<AlumniAccount[] | null>(null);
  let searching = $state(false);
  let error = $state('');
  let picked = $state<AlumniAccount | null>(null);
  let reason = $state('');

  const reasonState = $derived(alumniReasonState(reason));

  async function search(e?: SubmitEvent) {
    e?.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    Log.d('admin.alumni-manual.search', { dup: duplicate.uuid.slice(0, 8), length: q.length });
    searching = true;
    error = '';
    picked = null;
    try {
      results = await fetchAlumniMergeTargets(duplicate.uuid, q);
    } catch (err) {
      Log.d('admin.alumni-manual.search failed', err);
      error = alumniMergeErrorMessage(err);
      results = null;
    } finally {
      searching = false;
    }
  }

  function submit() {
    if (!picked || !reasonState.valid) return;
    onSubmit(picked, reason.trim());
  }
</script>

<div class="space-y-3" data-alumni-manual={duplicate.uuid}>
  <p class="text-text-muted text-xs">{m.admin_alumni_manual_intro()}</p>
  <form class="flex items-end gap-2" onsubmit={search}>
    <Input
      class="min-w-0 flex-1"
      label={m.admin_alumni_manual_search_label()}
      placeholder={m.admin_alumni_manual_search_placeholder()}
      bind:value={query}
      density="compact"
    />
    <Button
      type="submit"
      size="compact"
      variant="secondary"
      loading={searching}
      disabled={disabled || query.trim().length < 2}
    >
      <Search size={14} />
      {m.admin_alumni_manual_search_button()}
    </Button>
  </form>
  {#if error}
    <p class="text-red-err text-xs">{error}</p>
  {/if}
  {#if results && results.length === 0}
    <p class="text-text-muted text-xs" data-alumni-manual-empty>
      {m.admin_alumni_manual_no_result()}
    </p>
  {:else if results}
    <ul class="space-y-1" role="listbox" aria-label={m.admin_alumni_manual_search_label()}>
      {#each results as target (target.uuid)}
        <li>
          <Button
            variant="bare"
            class="w-full text-left"
            role="option"
            aria-selected={picked?.uuid === target.uuid}
            onclick={() => (picked = target)}
          >
            <div
              class="rounded-lg border px-3 py-2 text-sm {picked?.uuid === target.uuid
                ? 'border-accent bg-accent-tint'
                : 'border-black/5 dark:border-white/10'}"
            >
              <span class="text-text-main block truncate font-semibold">{target.name}</span>
              <span class="text-text-muted block truncate text-xs">
                {target.username} - {m.alumni_duplicates_promos({
                  promos: target.promos.join(', '),
                })}
                {#if target.email}- {target.email}{/if}
              </span>
            </div>
          </Button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if picked}
    <Textarea
      label={m.admin_alumni_manual_reason_label()}
      placeholder={m.admin_alumni_manual_reason_placeholder()}
      bind:value={reason}
      rows={3}
      required
      invalid={reason.length > 0 && !reasonState.valid}
    />
    <p
      class="text-xs {reasonState.valid ? 'text-text-muted' : 'text-red-err'}"
      data-alumni-manual-counter
    >
      {reasonState.problem === 'too_long'
        ? m.admin_alumni_manual_reason_too_long({
            length: reasonState.length,
            max: ALUMNI_MERGE_REASON_MAX,
          })
        : reasonState.problem === 'too_short'
          ? m.admin_alumni_manual_reason_too_short({
              length: reasonState.length,
              min: ALUMNI_MERGE_REASON_MIN,
            })
          : m.admin_alumni_manual_reason_count({
              length: reasonState.length,
              max: ALUMNI_MERGE_REASON_MAX,
            })}
    </p>
    <div class="flex justify-end">
      <Button
        size="compact"
        disabled={disabled || !reasonState.valid}
        onclick={submit}
        data-alumni-manual-submit
      >
        {m.admin_alumni_manual_submit()}
      </Button>
    </div>
  {/if}
</div>
