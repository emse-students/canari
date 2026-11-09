<script lang="ts">
  /**
   * "Partager mon activite" (engagement decision 9, WP-9): whether the member's reactions and
   * comments are told to the people who follow them (friends' activity), ON by default. Turning it
   * off stops every notice not yet sent and retracts none already sent. The switch shows the
   * SERVER's answer: it is drawn once that answer is read, and redrawn from what each write returns.
   * The shared `ui/Toggle` (docs/wiki/frontend/controls.md), never a hand-built switch.
   */
  import { onMount } from 'svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
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

  /** `wanted` is what the toggle now draws; the server's answer replaces it, a refusal undoes it. */
  async function save(wanted: boolean) {
    if (saving) return;
    saving = true;
    try {
      const saved = await setActivitySettings(wanted);
      shareActivity = saved.shareActivity;
      Log.i('ActivitySharingSetting', `saved ${saved.shareActivity}`);
    } catch (e: unknown) {
      Log.i('ActivitySharingSetting', `save failed: ${String(e)}`);
      shareActivity = !wanted;
      showToast(m.settings_share_activity_error(), 'error');
    } finally {
      saving = false;
    }
  }
</script>

{#if shareActivity !== null}
  <div data-activity-sharing-setting>
    <Toggle
      bind:checked={shareActivity}
      label={m.settings_share_activity()}
      hint={m.settings_share_activity_hint()}
      busy={saving}
      onchange={(v) => void save(v)}
    />
  </div>
{/if}
