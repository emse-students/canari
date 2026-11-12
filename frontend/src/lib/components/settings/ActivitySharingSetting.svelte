<script lang="ts">
  /**
   * "Partager mon activite" (engagement decision 9): whether a campus trend may NAME the member to
   * the people who follow them as someone who liked the post. OFF by default ("Nos principes", owner
   * 2026-11-10, principle 1: privacy wins) - the server reads no row as off. Turning it off takes the
   * name out of bell rows already written and stops every naming not yet sent. The switch shows the
   * SERVER's answer: it is drawn once that answer is read, and redrawn from what each write returns.
   * The shared `ui/Toggle` in its `row` layout (docs/wiki/frontend/controls.md): icon tile left, switch right.
   */
  import { onMount } from 'svelte';
  import { Users } from '@lucide/svelte';
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
    shareActivity = wanted;
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
      layout="row"
      icon={Users}
      checked={shareActivity}
      label={m.settings_share_activity()}
      hint={m.settings_share_activity_hint()}
      busy={saving}
      onchange={(v) => void save(v)}
    />
  </div>
{/if}
