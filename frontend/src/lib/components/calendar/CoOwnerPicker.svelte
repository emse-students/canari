<!--
  THE PARTNER-ASSOCIATION PICKER, AND THE LAST OF THE SEVEN TO READ THE ESTATE THE SAME WAY.

  This one is a multi-select over its own dropdown rather than a `<select>`, so it cannot use
  `AssociationOptions` - `<optgroup>` has no meaning here. It reads the SAME grouping helper, so
  the order and the two headings are decided in one place for every picker in the app.

  It also used to render `candidates.slice(0, 12)`, which is the "12" a user counted: the estate is
  larger than that, the list has scrolled since it was written (`max-h-48 overflow-y-auto`), and a
  cap with a scroll box under it only hides rows. Searching narrowed the list but the cap still cut
  whatever the search left, so an association past the twelfth was unreachable by browsing AND could
  be hidden from a search that matched too many names.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { listAssociations, type Association } from '$lib/associations/api';
  import { groupAssociationsForSelect, listOptionLabel } from '$lib/associations/selectGroups';
  import { m } from '$lib/paraglide/messages';
  import { X, Users } from '@lucide/svelte';

  interface Props {
    /** Selected co-owner association IDs (bindable). */
    selectedIds: string[];
    /** Association excluded from candidates (the event's primary owner). */
    excludeId?: string;
  }

  let { selectedIds = $bindable([]), excludeId = '' }: Props = $props();

  let allAssociations = $state<Association[]>([]);
  let searchQuery = $state('');
  let dropdownOpen = $state(false);

  onMount(async () => {
    try {
      allAssociations = await listAssociations();
    } catch {
      allAssociations = [];
    }
  });

  const candidates = $derived(
    allAssociations.filter(
      (a) =>
        a.id !== excludeId &&
        !selectedIds.includes(a.id) &&
        (searchQuery.trim() === '' || a.name.toLowerCase().includes(searchQuery.toLowerCase()))
    )
  );

  const grouped = $derived(groupAssociationsForSelect(candidates));

  const selected = $derived(allAssociations.filter((a) => selectedIds.includes(a.id)));

  /** The promo year rides on a list's label because two promos of one list share a name. */
  function optionLabel(asso: Association): string {
    return asso.type === 'list' ? listOptionLabel(asso) : asso.name;
  }

  function add(id: string) {
    if (!selectedIds.includes(id)) selectedIds = [...selectedIds, id];
    searchQuery = '';
    dropdownOpen = false;
  }

  function remove(id: string) {
    selectedIds = selectedIds.filter((x) => x !== id);
  }
</script>

<div class="border-cn-border/70 bg-cn-bg/30 space-y-2 rounded-xl border p-3">
  <p class="text-text-muted flex items-center gap-1 text-xs font-bold tracking-wide uppercase">
    <Users size={14} />
    {m.asso_calendar_co_owner_label()}
  </p>
  {#if selected.length > 0}
    <div class="flex flex-wrap gap-1.5">
      {#each selected as asso (asso.id)}
        <span
          class="border-cn-border text-text-main inline-flex items-center gap-1 rounded-full border bg-(--cn-surface) px-2.5 py-1 text-xs font-semibold"
        >
          {#if asso.color}
            <span class="inline-block h-2 w-2 shrink-0 rounded-full" style="background:{asso.color}"
            ></span>
          {/if}
          {optionLabel(asso)}
          <button
            type="button"
            onclick={() => remove(asso.id)}
            class="text-text-muted ml-0.5 transition-colors hover:text-red-500"
            aria-label={m.asso_calendar_co_owner_remove_aria({ name: asso.name })}
          >
            <X size={12} />
          </button>
        </span>
      {/each}
    </div>
  {/if}
  <div class="relative">
    <input
      type="text"
      placeholder={m.asso_calendar_co_owner_search_placeholder()}
      bind:value={searchQuery}
      onfocus={() => (dropdownOpen = true)}
      onblur={() => setTimeout(() => (dropdownOpen = false), 150)}
      class="border-cn-border text-text-main placeholder:text-text-muted w-full rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm"
    />
    {#if dropdownOpen && candidates.length > 0}
      <div
        class="border-cn-border bg-cn-surface absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border shadow-lg"
      >
        {#each [{ label: m.asso_select_group_assos(), items: grouped.assos }, { label: m.asso_select_group_lists(), items: grouped.lists }] as group (group.label)}
          {#if group.items.length > 0}
            <p
              class="text-text-muted bg-cn-bg/40 px-3 py-1 text-xs font-bold tracking-wide uppercase"
            >
              {group.label}
            </p>
            <ul>
              {#each group.items as asso (asso.id)}
                <li>
                  <button
                    type="button"
                    onmousedown={(e) => {
                      e.preventDefault();
                      add(asso.id);
                    }}
                    class="text-text-main hover:bg-cn-yellow/10 flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors"
                  >
                    {#if asso.color}
                      <span
                        class="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style="background:{asso.color}"
                      ></span>
                    {/if}
                    {optionLabel(asso)}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>
