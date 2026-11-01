<script lang="ts">
  /**
   * "Autoriser mes abonnes a republier mes posts" (WP-F6, owner 2026-11-01): the member's
   * account-wide consent to member reposts of their personal posts, ON by default. A post's own menu
   * overrides it either way. Turning it off removes, server-side and at once, every repost it no
   * longer covers. The switch shows the SERVER's answer: it is drawn once that answer is read, and
   * redrawn from what each write returns.
   */
  import { onMount } from 'svelte';
  import { Repeat2 } from '@lucide/svelte';
  import { getRepostSettings, setRepostSettings } from '$lib/posts/api';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  let allowReposts = $state<boolean | null>(null);
  let saving = $state(false);

  onMount(() => {
    getRepostSettings()
      .then((s) => (allowReposts = s.allowReposts))
      .catch((e: unknown) => Log.i('RepostConsentSetting', `read failed: ${String(e)}`));
  });

  async function toggle() {
    if (allowReposts === null || saving) return;
    saving = true;
    try {
      const saved = await setRepostSettings(!allowReposts);
      allowReposts = saved.allowReposts;
      Log.i('RepostConsentSetting', `saved ${saved.allowReposts}, removed ${saved.removed}`);
    } catch (e: unknown) {
      Log.i('RepostConsentSetting', `save failed: ${String(e)}`);
      showToast(m.settings_allow_reposts_error(), 'error');
    } finally {
      saving = false;
    }
  }
</script>

{#if allowReposts !== null}
  <div class="flex items-center justify-between gap-4" data-repost-consent-setting>
    <div class="flex items-center gap-3.5">
      <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
        <Repeat2 size={20} strokeWidth={2.5} />
      </div>
      <div>
        <p class="text-text-main text-sm font-bold">{m.settings_allow_reposts_label()}</p>
        <p class="text-text-muted mt-0.5 text-xs font-medium">{m.settings_allow_reposts_hint()}</p>
      </div>
    </div>

    <button
      role="switch"
      aria-checked={allowReposts}
      aria-label={m.settings_allow_reposts_label()}
      disabled={saving}
      onclick={() => void toggle()}
      class="focus-visible:ring-cn-yellow relative h-6 w-12 shrink-0 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2
 {allowReposts ? 'bg-cn-yellow' : 'bg-black/20 dark:bg-white/15'}"
    >
      <span
        class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200
 {allowReposts ? 'translate-x-6' : 'translate-x-0'}"
      ></span>
    </button>
  </div>
{/if}
