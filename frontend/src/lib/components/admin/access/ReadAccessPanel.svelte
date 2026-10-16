<script lang="ts">
  /**
   * NAMED READERS (WP-C): who reads the associations' posts of which campus and formation.
   *
   * Every change saves at once and offers "Undo" (user, 2026-10-16). There is no undo endpoint and
   * none is needed: `PUT /read-grants` is idempotent per cell, so undoing is the inverse write, and
   * the server journals it like any other change - the journal keeps both lines.
   */
  import { onMount } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { Eye } from '@lucide/svelte';
  import { Log } from '$lib/utils/Log';
  import {
    listReadGrants,
    setReadGrant,
    type ReadGrant,
    type ReadGrantJournalEntry,
  } from '$lib/associations/api';
  import { cellKey, grantees, journalCountLabel, type JournalLine } from '$lib/admin/readAccess';
  import {
    campusLabel,
    formationLabel,
    type Campus,
    type Formation,
  } from '$lib/profile/miconnectProfile';
  import { showToast, showUndoToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';
  import AccessSection from './AccessSection.svelte';
  import ReadGrantCard from './ReadGrantCard.svelte';
  import ReadGrantSheet, { type LastChange } from './ReadGrantSheet.svelte';
  import { createNameBook } from './nameBook.svelte';

  interface Props {
    /** True when a tab above already names this section. */
    titleHidden?: boolean;
  }

  let { titleHidden = false }: Props = $props();

  const names = createNameBook();
  let grants = $state<ReadGrant[]>([]);
  let journal = $state<ReadGrantJournalEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  /** The person whose sheet is open. */
  let editing = $state<string | null>(null);
  /** The last change saved from the open sheet, offered for undo inside it. */
  // `raw`: compared by identity in its own undo, which a deep proxy would never equal.
  let lastChange = $state.raw<LastChange | null>(null);
  const saving = new SvelteSet<string>();
  /** A cell's state while its write is in flight, so the box shows the click at once. */
  const optimistic = new SvelteMap<string, boolean>();

  // The server's cells, with each in-flight write laid over its own cell.
  const held = $derived(
    new Set([
      ...grants
        .map((g) => cellKey(g.userId, g.campus, g.formation))
        .filter((key) => optimistic.get(key) !== false),
      ...[...optimistic].filter(([, granted]) => granted).map(([key]) => key),
    ])
  );
  const people = $derived(grantees(grants));

  const scopeLabel = (formation: Formation | string | null) =>
    formation === null ? m.readaccess_whole_campus() : formationLabel(formation as Formation);

  const journalLines = $derived<JournalLine[]>(
    journal.map((entry, i) => {
      const args = {
        actor: names.nameOf(entry.actor),
        name: names.nameOf(entry.userId),
        campus: campusLabel(entry.campus as Campus),
        scope: scopeLabel(entry.formation),
      };
      return {
        key: `${i}|${entry.at}`,
        at: entry.at,
        text:
          entry.action === 'grant'
            ? m.readaccess_journal_grant(args)
            : m.readaccess_journal_revoke(args),
      };
    })
  );

  /** Numbers each re-read in the order it was SENT. */
  let refreshSent = 0;
  /** The number of the newest re-read whose answer is on screen. */
  let refreshApplied = 0;

  /**
   * Re-reads the grants and the journal. ANSWERS ARRIVE IN ANY ORDER: toggle A then B, and A's
   * re-read - sent before B was written - may land after B's, so applying it would draw B unticked
   * while the server holds it, and the next click would REVOKE it. An answer older than the one on
   * screen is dropped. Once a write's own re-read returns, the screen shows that answer or a newer
   * one, so the write is on it and its optimistic overlay may go.
   */
  async function loadGrants() {
    const seq = ++refreshSent;
    const res = await listReadGrants();
    if (seq < refreshApplied) {
      Log.d('admin.read-access.refresh superseded', { seq, applied: refreshApplied });
      return;
    }
    refreshApplied = seq;
    grants = res.grants;
    journal = res.journal;
    names.resolve([
      ...res.grants.map((g) => g.userId),
      ...res.journal.flatMap((j) => [j.userId, j.actor]),
    ]);
  }

  /**
   * Writes one cell. The server is the truth, so the list is re-read after the write; a failed
   * re-read is a stale list, not a failed save, and says so. `undoable` offers the inverse write in
   * a toast; the undo itself is not undoable (it would only toggle back and forth).
   */
  async function writeCell(
    userId: string,
    campus: Campus,
    formation: Formation | null,
    granted: boolean,
    undoable: boolean
  ) {
    const key = cellKey(userId, campus, formation);
    if (saving.has(key)) {
      // Only an undo reaches here (the sheet puts a busy box back itself): say why nothing happened.
      Log.d('admin.read-access.write refused, cell still saving', { key });
      showToast(m.readaccess_busy(), 'warning');
      return;
    }
    saving.add(key);
    optimistic.set(key, granted);
    error = null;
    Log.d('admin.read-access.write', { userId, campus, formation, granted, undoable });
    try {
      await setReadGrant(userId, campus, formation, granted);
    } catch (e) {
      Log.d('admin.read-access.write failed', e);
      error = m.readaccess_save_error();
      optimistic.delete(key);
      saving.delete(key);
      return;
    }
    try {
      await loadGrants();
    } catch (e) {
      Log.d('admin.read-access.refresh failed', e);
      error = m.readaccess_refresh_error();
    } finally {
      optimistic.delete(key);
      saving.delete(key);
    }
    if (!undoable) return;
    const args = {
      name: names.nameOf(userId),
      campus: campusLabel(campus),
      scope: scopeLabel(formation),
    };
    const text = granted ? m.readaccess_granted_toast(args) : m.readaccess_revoked_toast(args);
    const change: LastChange = {
      text,
      undo: () => {
        Log.d('admin.read-access.undo', { userId, campus, formation, granted: !granted });
        if (lastChange === change) lastChange = null;
        void writeCell(userId, campus, formation, !granted, false);
      },
    };
    // The toast for a pointer, the row inside the sheet for a keyboard held by its focus trap.
    lastChange = change;
    showUndoToast(text, change.undo);
  }

  function openSheet(userId: string): boolean {
    Log.d('admin.read-access.openSheet', { userId });
    names.resolve([userId]);
    lastChange = null;
    error = null;
    editing = userId;
    return true;
  }

  function closeSheet() {
    Log.d('admin.read-access.closeSheet', { userId: editing });
    editing = null;
    lastChange = null;
  }

  onMount(async () => {
    try {
      await loadGrants();
    } catch (e) {
      Log.d('admin.read-access.load failed', e);
      error = m.common_load_error();
    } finally {
      loading = false;
    }
  });
</script>

<!-- While the sheet is open the error is said inside it; the page behind is dimmed. -->
{#if error && !editing}
  <p class="text-red-err mb-4 text-sm" role="alert">{error}</p>
{/if}

<AccessSection
  title={m.readaccess_title()}
  {titleHidden}
  summary={m.readaccess_subtitle()}
  details={m.readaccess_details()}
  addPlaceholder={m.readaccess_add_placeholder()}
  addLabel={m.readaccess_add_button()}
  inputId="add-read-grantee-autocomplete"
  onAdd={openSheet}
  {loading}
  count={people.length}
  emptyIcon={Eye}
  emptyTitle={m.readaccess_empty()}
  emptyDescription={m.readaccess_empty_desc()}
  journal={journalLines}
  journalLabel={m.readaccess_journal_summary({ count: journalCountLabel(journal.length) })}
  journalEmpty={m.readaccess_journal_empty()}
>
  {#snippet list()}
    {#each people as userId (userId)}
      <ReadGrantCard
        name={names.nameOf(userId)}
        grants={grants.filter((g) => g.userId === userId)}
        onEdit={() => openSheet(userId)}
      />
    {/each}
  {/snippet}
</AccessSection>

{#if editing}
  {@const userId = editing}
  <ReadGrantSheet
    open
    {userId}
    name={names.nameOf(userId)}
    {held}
    {saving}
    onToggle={(campus, formation) =>
      void writeCell(
        userId,
        campus,
        formation,
        !held.has(cellKey(userId, campus, formation)),
        true
      )}
    {error}
    {lastChange}
    onClose={closeSheet}
  />
{/if}
