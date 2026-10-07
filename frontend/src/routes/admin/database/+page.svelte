<script lang="ts">
  import { resolve } from '$app/paths';
  import { Log } from '$lib/utils/Log';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { isTauriRuntime } from '$lib/utils/tauriRuntime';
  import {
    AdminerForbiddenError,
    AdminerUnavailableError,
    openAdminer,
  } from '$lib/admin/adminerSession';
  import { Database, ExternalLink, TriangleAlert } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /** The session cookie only reaches the app's own origin: the native apps run on another one. */
  const inNativeApp = isTauriRuntime();

  let opening = $state(false);
  /** What went wrong, in words - never swallowed, never a bare "error". */
  let problem = $state<string | null>(null);

  onMount(() => {
    if (!isGlobalAdmin()) void goto(resolve('/admin'), { replaceState: true });
  });

  async function open() {
    if (opening) return;
    opening = true;
    problem = null;
    try {
      await openAdminer();
    } catch (err) {
      Log.d('admin.database.open failed', err);
      problem =
        err instanceof AdminerUnavailableError
          ? m.admin_database_unavailable()
          : err instanceof AdminerForbiddenError
            ? m.admin_database_forbidden()
            : m.admin_database_failed();
    } finally {
      opening = false;
    }
  }
</script>

<section class="space-y-5">
  <header class="flex items-center gap-3">
    <Database size={22} class="text-cn-yellow" />
    <h1 class="text-text-main text-xl font-bold">{m.admin_database_title()}</h1>
  </header>

  <p class="text-text-muted text-sm leading-relaxed">{m.admin_database_intro()}</p>

  <div
    class="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
    role="note"
  >
    <TriangleAlert size={18} class="mt-0.5 shrink-0 text-amber-600" />
    <p class="text-text-main leading-relaxed">{m.admin_database_warning()}</p>
  </div>

  <ul class="text-text-muted list-disc space-y-1 pl-5 text-sm">
    <li>{m.admin_database_point_session()}</li>
    <li>{m.admin_database_point_login()}</li>
  </ul>

  {#if inNativeApp}
    <p class="text-text-muted text-sm font-semibold" role="status">
      {m.admin_database_web_only()}
    </p>
  {:else}
    <button
      type="button"
      onclick={open}
      disabled={opening}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-bold transition-colors disabled:opacity-60"
    >
      <ExternalLink size={16} strokeWidth={2.5} />
      {m.admin_database_open()}
    </button>
  {/if}

  {#if problem}
    <p class="text-red-err text-sm font-semibold" role="alert">{problem}</p>
  {/if}
</section>
