<script lang="ts">
  import { resolve } from '$app/paths';
  import { Log } from '$lib/utils/Log';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin, isAssociationSuperAdmin } from '$lib/stores/user';
  import {
    ensureAssociationSuperAdmin,
    listDocumentReviewers,
    addDocumentReviewer,
    removeDocumentReviewer,
    listReadGrants,
    setReadGrant,
    type DocumentReviewerGrant,
    type ReadGrant,
    type ReadGrantJournalEntry,
  } from '$lib/associations/api';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { CAMPUSES, FORMATIONS, campusLabel, formationLabel } from '$lib/profile/miconnectProfile';
  import type { Campus, Formation } from '$lib/profile/miconnectProfile';
  import { Eye, FileCheckCorner, Trash2, UserPlus } from '@lucide/svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { m } from '$lib/paraglide/messages';

  let ready = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let resolvedNames = $state<Record<string, string>>({});
  /** Whether this viewer may use the grid (global admin); BDE super-admins keep only reviewers. */
  let canGrant = $state(false);

  // ── Read grants ────────────────────────────────────────────────────────────────────────
  let grants = $state<ReadGrant[]>([]);
  let journal = $state<ReadGrantJournalEntry[]>([]);
  /** People added on the page who hold no cell yet: a row exists once someone is named. */
  let addedPeople = $state<string[]>([]);
  let newGrantee = $state('');
  const savingCells = new SvelteSet<string>();

  /** A cell's identity: one string per (person, campus, formation-or-whole-campus). */
  const cellKey = (userId: string, campus: string, formation: string | null) =>
    `${userId}|${campus}|${formation ?? '*'}`;

  const heldCells = $derived(new Set(grants.map((g) => cellKey(g.userId, g.campus, g.formation))));
  const people = $derived([...new Set([...grants.map((g) => g.userId), ...addedPeople])]);

  function nameOf(id: string): string {
    return resolvedNames[id] ?? id;
  }

  function scopeLabel(formation: string | null): string {
    return formation === null
      ? m.readaccess_whole_campus()
      : formationLabel(formation as Formation);
  }

  /** Resolves display names for a set of user ids (sync cache first, then async). */
  function resolveNames(ids: string[]) {
    for (const id of ids) {
      resolvedNames = { ...resolvedNames, [id]: getUserDisplayNameSync(id) || id };
      void resolveUserDisplayName(id).then((name) => {
        if (name) resolvedNames = { ...resolvedNames, [id]: name };
      });
    }
  }

  async function loadGrants() {
    const res = await listReadGrants();
    grants = res.grants;
    journal = res.journal;
    resolveNames([
      ...new Set([
        ...res.grants.map((g) => g.userId),
        ...res.grants.map((g) => g.grantedBy),
        ...res.journal.flatMap((j) => [j.userId, j.actor]),
      ]),
    ]);
  }

  function addPerson() {
    const id = newGrantee.trim();
    if (!id) return;
    if (!people.includes(id)) {
      addedPeople = [...addedPeople, id];
      resolveNames([id]);
    }
    newGrantee = '';
  }

  /** Ticks or unticks one cell; the server is the truth, so the grid is re-read after the write. */
  async function toggleCell(userId: string, campus: Campus, formation: Formation | null) {
    const key = cellKey(userId, campus, formation);
    if (savingCells.has(key)) return;
    savingCells.add(key);
    error = null;
    try {
      Log.d('admin.read-access.toggle', { userId, campus, formation });
      await setReadGrant(userId, campus, formation, !heldCells.has(key));
    } catch (e) {
      Log.d('admin.read-access.toggle failed', e);
      error = m.readaccess_save_error();
      savingCells.delete(key);
      return;
    }
    // The write SUCCEEDED: a failed re-read is a stale grid, not a failed save, and says so.
    try {
      await loadGrants();
    } catch (e) {
      Log.d('admin.read-access.refresh failed', e);
      error = m.readaccess_refresh_error();
    } finally {
      savingCells.delete(key);
    }
  }

  // ── Document reviewers (unchanged capability, same page) ──────────────────────────────
  let reviewers = $state<DocumentReviewerGrant[]>([]);
  let newUserId = $state('');
  let adding = $state(false);
  const removingIds = new SvelteSet<string>();

  async function load() {
    loading = true;
    error = null;
    // The two lists load INDEPENDENTLY: one failing must not hide the other's section.
    const [reviewersResult, grantsResult] = await Promise.allSettled([
      listDocumentReviewers(),
      canGrant ? loadGrants() : Promise.resolve(),
    ]);
    if (reviewersResult.status === 'fulfilled') {
      reviewers = reviewersResult.value;
      resolveNames(reviewers.map((r) => r.userId));
    } else {
      Log.d('admin.read-access.load reviewers failed', reviewersResult.reason);
    }
    if (grantsResult.status === 'rejected') {
      Log.d('admin.read-access.load grants failed', grantsResult.reason);
    }
    if (reviewersResult.status === 'rejected' || grantsResult.status === 'rejected') {
      error = m.common_load_error();
    }
    loading = false;
  }

  async function handleAdd() {
    const userId = newUserId.trim();
    if (!userId || adding) return;
    adding = true;
    error = null;
    try {
      const grant = await addDocumentReviewer(userId);
      if (!reviewers.some((r) => r.userId === grant.userId)) {
        reviewers = [grant, ...reviewers];
        resolveNames([grant.userId]);
      }
      newUserId = '';
    } catch (e) {
      Log.d('admin.read-access.handleAdd failed', e);
      error = m.common_generic_error_label();
    } finally {
      adding = false;
    }
  }

  async function handleRemove(grant: DocumentReviewerGrant) {
    const name = nameOf(grant.userId);
    if (
      !(await showConfirm(m.docreview_revoke_confirm({ name }), {
        danger: true,
        confirmLabel: m.docreview_revoke_button(),
      }))
    )
      return;
    removingIds.add(grant.userId);
    error = null;
    try {
      await removeDocumentReviewer(grant.userId);
      reviewers = reviewers.filter((r) => r.userId !== grant.userId);
    } catch (e) {
      Log.d('admin.read-access.handleRemove failed', e);
      error = m.common_delete_error();
    } finally {
      removingIds.delete(grant.userId);
    }
  }

  onMount(async () => {
    await ensureAssociationSuperAdmin();
    if (!isGlobalAdmin() && !isAssociationSuperAdmin()) {
      void goto(resolve('/admin'), { replaceState: true });
      return;
    }
    // Cross-space rights stay with global admins (D24): the grid and the journal are theirs alone.
    canGrant = isGlobalAdmin();
    ready = true;
    void load();
  });
</script>

{#if ready}
  <div class="space-y-8">
    {#if error}
      <p class="text-sm text-red-500" role="alert">{error}</p>
    {/if}
    {#if canGrant}
      <section class="space-y-4">
        <header class="flex items-start gap-3">
          <span
            class="bg-cn-yellow/15 text-cn-dark flex h-10 w-10 items-center justify-center rounded-xl"
          >
            <Eye size={20} />
          </span>
          <div>
            <h2 class="text-text-main text-lg font-bold">{m.readaccess_title()}</h2>
            <p class="text-text-muted mt-0.5 text-sm">{m.readaccess_subtitle()}</p>
          </div>
        </header>

        <form
          class="flex flex-col gap-3 sm:flex-row"
          onsubmit={(e) => {
            e.preventDefault();
            addPerson();
          }}
        >
          <div class="min-w-0 flex-1">
            <UserAutocomplete
              value={newGrantee}
              onValueChange={(v) => (newGrantee = v)}
              placeholder={m.readaccess_add_placeholder()}
              inputId="add-read-grantee-autocomplete"
              onSubmit={addPerson}
            />
          </div>
          <button
            type="submit"
            disabled={!newGrantee.trim()}
            class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-50"
          >
            <UserPlus size={16} />
            {m.readaccess_add_button()}
          </button>
        </form>

        {#if loading}
          <div class="flex justify-center py-10">
            <div
              class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
            ></div>
          </div>
        {:else if people.length === 0}
          <p class="text-text-muted text-sm">{m.readaccess_empty()}</p>
        {:else}
          <div class="border-cn-border overflow-x-auto rounded-2xl border bg-(--cn-surface)">
            <table class="w-full text-left text-sm">
              <thead>
                <tr class="border-cn-border border-b">
                  <th rowspan="2" class="text-text-muted px-4 py-2 align-bottom font-semibold">
                    &nbsp;
                  </th>
                  {#each CAMPUSES as campus (campus)}
                    <th
                      colspan={FORMATIONS.length + 1}
                      class="text-text-main border-cn-border border-l px-3 py-2 text-center font-bold"
                    >
                      {campusLabel(campus)}
                    </th>
                  {/each}
                </tr>
                <tr class="border-cn-border border-b">
                  {#each CAMPUSES as campus (campus)}
                    <th
                      class="text-text-muted border-cn-border border-l px-2 py-2 text-center text-xs"
                    >
                      {m.readaccess_whole_campus()}
                    </th>
                    {#each FORMATIONS as formation (formation)}
                      <th class="text-text-muted px-2 py-2 text-center text-xs">
                        {formationLabel(formation)}
                      </th>
                    {/each}
                  {/each}
                </tr>
              </thead>
              <tbody class="divide-cn-border/70 divide-y">
                {#each people as userId (userId)}
                  <tr>
                    <th class="text-text-main px-4 py-2 font-semibold whitespace-nowrap">
                      {nameOf(userId)}
                    </th>
                    {#each CAMPUSES as campus (campus)}
                      {#each [null, ...FORMATIONS] as formation, i (formation ?? '*')}
                        {@const key = cellKey(userId, campus, formation)}
                        <td
                          class="px-2 py-2 text-center {i === 0 ? 'border-cn-border border-l' : ''}"
                        >
                          <input
                            type="checkbox"
                            class="h-4 w-4"
                            checked={heldCells.has(key)}
                            disabled={savingCells.has(key)}
                            aria-label={m.readaccess_cell_label({
                              name: nameOf(userId),
                              campus: campusLabel(campus),
                              scope: scopeLabel(formation),
                            })}
                            onchange={() => toggleCell(userId, campus, formation)}
                          />
                        </td>
                      {/each}
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="text-text-muted text-xs">{m.readaccess_istp_note()}</p>
        {/if}

        <div class="space-y-2">
          <h3 class="text-text-main text-sm font-bold">{m.readaccess_journal_title()}</h3>
          {#if journal.length === 0}
            <p class="text-text-muted text-sm">{m.readaccess_journal_empty()}</p>
          {:else}
            <ul class="text-text-muted space-y-1 text-xs">
              {#each journal as entry, i (i)}
                {@const args = {
                  actor: nameOf(entry.actor),
                  name: nameOf(entry.userId),
                  campus: campusLabel(entry.campus as Campus),
                  scope: scopeLabel(entry.formation),
                }}
                <li>
                  {new Date(entry.at).toLocaleString()} -
                  {entry.action === 'grant'
                    ? m.readaccess_journal_grant(args)
                    : m.readaccess_journal_revoke(args)}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </section>
    {/if}

    <section class="space-y-4">
      <header class="flex items-start gap-3">
        <span
          class="bg-cn-yellow/15 text-cn-dark flex h-10 w-10 items-center justify-center rounded-xl"
        >
          <FileCheckCorner size={20} />
        </span>
        <div>
          <h2 class="text-text-main text-lg font-bold">{m.docreview_title()}</h2>
          <p class="text-text-muted mt-0.5 text-sm">{m.docreview_subtitle()}</p>
        </div>
      </header>

      <form
        class="flex flex-col gap-3 sm:flex-row"
        onsubmit={(e) => {
          e.preventDefault();
          void handleAdd();
        }}
      >
        <div class="min-w-0 flex-1">
          <UserAutocomplete
            value={newUserId}
            onValueChange={(v) => (newUserId = v)}
            placeholder={m.docreview_add_placeholder()}
            inputId="add-reviewer-autocomplete"
            onSubmit={handleAdd}
          />
        </div>
        <button
          type="submit"
          disabled={adding || !newUserId.trim()}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-50"
        >
          <UserPlus size={16} />
          {adding ? m.common_saving_label() : m.docreview_add_button()}
        </button>
      </form>

      {#if !loading}
        <div
          class="border-cn-border divide-cn-border/70 divide-y overflow-hidden rounded-2xl border bg-(--cn-surface)"
        >
          {#if reviewers.length === 0}
            <p class="text-text-muted px-4 py-8 text-center text-sm">{m.docreview_empty()}</p>
          {:else}
            {#each reviewers as grant (grant.userId)}
              <div class="flex items-center justify-between gap-3 px-4 py-3">
                <div class="min-w-0">
                  <span class="text-text-main block truncate text-sm font-semibold">
                    {nameOf(grant.userId)}
                  </span>
                  <span class="text-text-muted block truncate text-xs">
                    {m.docreview_granted_on({
                      date: new Date(grant.createdAt).toLocaleDateString(),
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  onclick={() => handleRemove(grant)}
                  disabled={removingIds.has(grant.userId)}
                  title={m.docreview_revoke_button()}
                  class="ui-icon-button border-red-err/30 bg-red-err/10 text-red-err hover:bg-red-err/20 rounded-xl border transition-colors disabled:opacity-50"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            {/each}
          {/if}
        </div>
      {/if}
    </section>
  </div>
{/if}
