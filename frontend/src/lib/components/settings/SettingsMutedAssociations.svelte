<script lang="ts">
  import { onMount } from 'svelte';
  import { Log } from '$lib/utils/Log';
  import { listMutedAssociations, unmuteAssociationPush } from '$lib/associations/api';
  import { m } from '$lib/paraglide/messages';

  /**
   * The associations whose PUSH the account silenced, each with the way back. The mute itself is
   * made from the association's page; this list exists so a mute is never a one-way door. The
   * server applies it before sending, so nothing here is what actually silences a push.
   */
  type Muted = Awaited<ReturnType<typeof listMutedAssociations>>[number];

  let muted = $state<Muted[]>([]);
  let loaded = $state(false);
  let loadError = $state(false);
  let saveError = $state(false);
  let busyId = $state<string | null>(null);

  onMount(async () => {
    try {
      muted = await listMutedAssociations();
    } catch (err) {
      Log.d('SettingsMutedAssociations.load failed', err);
      loadError = true;
    } finally {
      loaded = true;
    }
  });

  async function unmute(id: string) {
    busyId = id;
    saveError = false;
    try {
      await unmuteAssociationPush(id);
      muted = muted.filter((a) => a.id !== id);
    } catch (err) {
      Log.d('SettingsMutedAssociations.unmute failed', err);
      saveError = true;
    } finally {
      busyId = null;
    }
  }
</script>

<div class="border-cn-border mt-8 border-t pt-6" data-testid="muted-associations">
  <h3 class="text-text-main text-sm font-bold">{m.settings_notif_muted_heading()}</h3>
  <p class="text-text-muted mt-0.5 text-xs font-medium">{m.settings_notif_muted_desc()}</p>

  {#if loadError}
    <p class="mt-3 rounded-xl bg-red-500/10 px-4 py-3 text-sm font-medium text-red-600">
      {m.settings_notif_muted_load_error()}
    </p>
  {/if}

  {#if saveError}
    <p class="mt-3 rounded-xl bg-red-500/10 px-4 py-3 text-sm font-medium text-red-600">
      {m.settings_notifications_save_error()}
    </p>
  {/if}

  {#if loaded && muted.length === 0 && !loadError}
    <p class="text-text-muted mt-3 text-xs font-medium">{m.settings_notif_muted_empty()}</p>
  {/if}

  <ul class="mt-3 space-y-2">
    {#each muted as asso (asso.id)}
      <li class="flex items-center justify-between gap-3" data-association={asso.id}>
        <span class="text-text-main min-w-0 truncate text-sm font-medium">{asso.name}</span>
        <button
          type="button"
          disabled={busyId === asso.id}
          aria-label={m.settings_notif_muted_unmute_aria({ name: asso.name })}
          onclick={() => void unmute(asso.id)}
          class="border-cn-border text-text-main shrink-0 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-(--cn-surface) disabled:opacity-50"
        >
          {m.settings_notif_muted_unmute()}
        </button>
      </li>
    {/each}
  </ul>
</div>
