<script lang="ts">
  import { Loader, LogOut, Monitor, ShieldAlert, Smartphone, Trash2 } from '@lucide/svelte';
  import Modal from '../shared/Modal.svelte';
  import {
    describeUserAgent,
    fetchAuthSessions,
    revokeAuthSession,
    revokeOtherAuthSessions,
    type AuthSessionInfo,
  } from '$lib/services/authSessions';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { exactDate, timeAgo } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether the modal is visible. */
    open: boolean;
    /** Callback to close the modal. */
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  let sessions = $state<AuthSessionInfo[]>([]);
  let loading = $state(false);
  let error = $state('');
  /** Id of the session currently being revoked, so only its own row shows a spinner. */
  let revoking = $state<string | null>(null);

  const others = $derived(sessions.filter((s) => !s.current).length);

  $effect(() => {
    if (open) void load();
  });

  async function load() {
    loading = true;
    error = '';
    try {
      sessions = await fetchAuthSessions();
    } catch (e) {
      console.error('[SESSIONS] Load failed', e);
      error = m.settings_sessions_load_error();
    } finally {
      loading = false;
    }
  }

  async function revokeOne(session: AuthSessionInfo) {
    const confirmed = await showConfirm(
      session.current
        ? m.settings_sessions_revoke_current_confirm()
        : m.settings_sessions_revoke_confirm(),
      { danger: true, confirmLabel: m.settings_sessions_revoke_btn() }
    );
    if (!confirmed) return;

    revoking = session.id;
    try {
      await revokeAuthSession(session.id);
      showToast(m.settings_sessions_revoked_toast(), 'info');
      // Revoking the current session leaves this client holding a dead cookie;
      // the next API call fails and the app routes to /login on its own, so the
      // list is simply reloaded here rather than second-guessing that flow.
      await load();
    } catch (e) {
      console.error('[SESSIONS] Revoke failed', e);
      error = m.settings_sessions_revoke_error();
    } finally {
      revoking = null;
    }
  }

  async function revokeAllOthers() {
    const confirmed = await showConfirm(m.settings_sessions_revoke_others_confirm(), {
      danger: true,
      confirmLabel: m.settings_sessions_revoke_others_btn(),
    });
    if (!confirmed) return;

    revoking = 'others';
    try {
      const count = await revokeOtherAuthSessions();
      showToast(m.settings_sessions_revoked_count_toast({ count }), 'info');
      await load();
    } catch (e) {
      console.error('[SESSIONS] Revoke-others failed', e);
      error = m.settings_sessions_revoke_error();
    } finally {
      revoking = null;
    }
  }
</script>

<Modal {open} title={m.settings_sessions_title()} {onClose} maxWidth="max-w-xl">
  <div class="px-1 space-y-5 pb-2">
    <p class="text-sm text-text-muted leading-relaxed">
      {m.settings_sessions_intro()}
    </p>

    {#if error}
      <div
        class="flex items-start gap-3 p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 shadow-inner"
      >
        <ShieldAlert size={20} class="shrink-0 mt-0.5" />
        <p class="text-sm font-medium leading-relaxed">{error}</p>
      </div>
    {/if}

    {#if loading}
      <div class="flex flex-col items-center justify-center py-12 gap-4 text-text-muted">
        <Loader size={28} class="animate-spin text-amber-500" />
        <span class="text-sm font-semibold tracking-wide">{m.settings_sessions_loading()}</span>
      </div>
    {:else}
      <div class="space-y-3">
        {#each sessions as session (session.id)}
          {@const info = describeUserAgent(session.userAgent, m.settings_sessions_unknown_device())}
          <div
            class="rounded-[1.5rem] border p-4 flex items-start gap-4 transition-all duration-300
              {session.current
              ? 'border-amber-500/30 bg-amber-500/5 shadow-inner'
              : 'border-black/5 dark:border-white/10 bg-white/40 dark:bg-black/20'}"
          >
            <div
              class="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 shadow-sm
                {session.current
                ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                : 'bg-white/80 dark:bg-white/10 text-text-muted'}"
            >
              {#if info.kind === 'mobile'}
                <Smartphone size={22} strokeWidth={2} />
              {:else}
                <Monitor size={22} strokeWidth={2} />
              {/if}
            </div>

            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <p class="text-sm font-bold text-text-main truncate">{info.label}</p>
                {#if session.current}
                  <span
                    class="text-[0.65rem] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300"
                  >
                    {m.settings_sessions_current_badge()}
                  </span>
                {/if}
              </div>
              <p
                class="text-xs font-medium text-text-muted mt-1"
                title={exactDate(session.lastUsedAt)}
              >
                {m.settings_sessions_last_used({ when: timeAgo(session.lastUsedAt) })}
              </p>
              <p class="text-xs font-medium text-text-muted/70 mt-0.5">
                {m.settings_sessions_started({ when: exactDate(session.createdAt) })}
                {#if session.lastIp}
                  <span class="font-mono"> - {session.lastIp}</span>
                {/if}
              </p>
            </div>

            <button
              onclick={() => void revokeOne(session)}
              disabled={revoking !== null}
              aria-label={m.settings_sessions_revoke_btn()}
              class="shrink-0 p-2.5 rounded-xl text-red-500 hover:bg-red-500/10 transition-all active:scale-95 disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              {#if revoking === session.id}
                <Loader size={18} class="animate-spin" />
              {:else}
                <Trash2 size={18} strokeWidth={2.5} />
              {/if}
            </button>
          </div>
        {/each}
      </div>

      {#if others > 0}
        <button
          onclick={() => void revokeAllOthers()}
          disabled={revoking !== null}
          class="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm font-bold text-red-600 dark:text-red-400 hover:bg-red-500/20 transition-all active:scale-[0.99] disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          {#if revoking === 'others'}
            <Loader size={16} class="animate-spin" />
          {:else}
            <LogOut size={16} strokeWidth={2.5} />
          {/if}
          {m.settings_sessions_revoke_others_btn()}
        </button>
      {/if}

      <!-- Stated because it is surprising: an access token already handed out is
           verified without a database round trip, so it keeps working until it
           expires. Hiding that would make the button look like it did nothing. -->
      <p class="text-xs text-text-muted/70 leading-relaxed">
        {m.settings_sessions_delay_note()}
      </p>
    {/if}
  </div>
</Modal>
