<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { Log } from '$lib/utils/Log';
  import { listReducedBells, setBellLevel, type ReducedBell } from '$lib/follows/bell';
  import { userDisplayNames } from '$lib/utils/users/displayNames.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE ACCOUNTS WHOSE BELL THE READER REDUCED (engagement WP-3), each with the way back to posts and
   * lives - so a reduction is never a one-way door. It replaced the list of muted associations: a
   * mute is the bell's "Rien" on an association. The bell itself is set from the association's page
   * or a followed person's profile; the server applies it before sending, so nothing here is what
   * actually withholds a push.
   */
  let rows = $state<ReducedBell[]>([]);
  let loaded = $state(false);
  let loadError = $state(false);
  let saveError = $state(false);
  let busyKey = $state<string | null>(null);

  const people = userDisplayNames(() =>
    rows.filter((r) => r.kind === 'user').map((r) => r.targetId)
  );

  const keyOf = (r: ReducedBell) => `${r.kind}:${r.targetId}`;
  const nameOf = (r: ReducedBell) => r.name ?? people.get(r.targetId) ?? r.targetId;
  const levelLabel = (r: ReducedBell) =>
    r.level === 'lives' ? m.bell_level_lives() : m.bell_level_none();

  onMount(async () => {
    try {
      rows = await listReducedBells();
    } catch (err) {
      Log.d('SettingsAccountBells.load failed', err);
      loadError = true;
    } finally {
      loaded = true;
    }
  });

  async function restore(row: ReducedBell) {
    busyKey = keyOf(row);
    saveError = false;
    try {
      await setBellLevel(row.kind, row.targetId, 'all');
      rows = rows.filter((r) => keyOf(r) !== keyOf(row));
    } catch (err) {
      Log.d('SettingsAccountBells.restore failed', err);
      saveError = true;
    } finally {
      busyKey = null;
    }
  }
</script>

<div class="border-cn-border mt-8 border-t pt-6" data-testid="reduced-bells">
  <h3 class="text-text-main text-sm font-bold">{m.settings_bells_heading()}</h3>
  <p class="text-text-muted mt-0.5 text-xs font-medium">{m.settings_bells_desc()}</p>

  {#if loadError}
    <p class="mt-3 rounded-xl bg-red-500/10 px-4 py-3 text-sm font-medium text-red-600">
      {m.settings_bells_load_error()}
    </p>
  {/if}

  {#if saveError}
    <p class="mt-3 rounded-xl bg-red-500/10 px-4 py-3 text-sm font-medium text-red-600">
      {m.settings_notifications_save_error()}
    </p>
  {/if}

  {#if loaded && rows.length === 0 && !loadError}
    <p class="text-text-muted mt-3 text-xs font-medium">{m.settings_bells_empty()}</p>
  {/if}

  <ul class="mt-3 space-y-2">
    {#each rows as row (keyOf(row))}
      <li class="flex items-center justify-between gap-3" data-bell={keyOf(row)}>
        <span class="flex min-w-0 flex-col">
          <span class="text-text-main truncate text-sm font-medium">{nameOf(row)}</span>
          <span class="text-text-muted text-xs">{levelLabel(row)}</span>
        </span>
        <Button
          variant="secondary"
          size="compact"
          disabled={busyKey === keyOf(row)}
          aria-label={m.settings_bells_restore_aria({ name: nameOf(row) })}
          onclick={() => void restore(row)}
        >
          {m.settings_bells_restore()}
        </Button>
      </li>
    {/each}
  </ul>
</div>
