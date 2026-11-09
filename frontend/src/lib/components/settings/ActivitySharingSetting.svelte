<script lang="ts">
  /**
   * "Partager mon activite" (engagement decision 9, WP-9): whether the member's reactions and
   * comments are told to the people who follow them (friends' activity), ON by default. Turning it
   * off stops every notice not yet sent and retracts none already sent. The switch shows the
   * SERVER's answer: it is drawn once that answer is read, and redrawn from what each write returns.
   */
  import { onMount } from 'svelte';
  import { Activity } from '@lucide/svelte';
  import { getActivitySettings, setActivitySettings } from '$lib/posts/api';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  let shareActivity = $state<boolean | null>(null);
  let saving = $state(false);

  onMount(() => {
    getActivitySettings()
      .then((s) => (shareActivity = s.shareActivity))
      .catch((e: unknown) => Log.i('ActivitySharingSetting', `read failed: ${String(e)}`));
  });

  async function toggle() {
    if (shareActivity === null || saving) return;
    saving = true;
    try {
      const saved = await setActivitySettings(!shareActivity);
      shareActivity = saved.shareActivity;
      Log.i('ActivitySharingSetting', `saved ${saved.shareActivity}`);
    } catch (e: unknown) {
      Log.i('ActivitySharingSetting', `save failed: ${String(e)}`);
      showToast(m.settings_share_activity_error(), 'error');
    } finally {
      saving = false;
    }
  }
</script>

{#if shareActivity !== null}
  <div class="flex items-center justify-between gap-4" data-activity-sharing-setting>
    <div class="flex items-center gap-3.5">
      <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
        <Activity size={20} strokeWidth={2.5} />
      </div>
      <div>
        <p class="text-text-main text-sm font-bold">{m.settings_share_activity()}</p>
        <p class="text-text-muted mt-0.5 text-xs font-medium">{m.settings_share_activity_hint()}</p>
      </div>
    </div>

    <button
      role="switch"
      aria-checked={shareActivity}
      aria-label={m.settings_share_activity()}
      disabled={saving}
      onclick={() => void toggle()}
      class="focus-visible:ring-cn-yellow relative h-6 w-12 shrink-0 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2
 {shareActivity ? 'bg-cn-yellow' : 'bg-black/20 dark:bg-white/15'}"
    >
      <span
        class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200
 {shareActivity ? 'translate-x-6' : 'translate-x-0'}"
      ></span>
    </button>
  </div>
{/if}
