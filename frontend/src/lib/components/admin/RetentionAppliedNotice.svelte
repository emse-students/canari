<script lang="ts">
  import { RefreshCw } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { coreUrl } from '$lib/utils/apiUrl';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * Whether media-service stamps new conversation files with the retention durations saved on
   * /admin/platform (re-review of #3521, docs/wiki/retention-settings.md). Core compares what
   * media-service HOLDS with the columns - no timer, no retry: while they differ the page says "pas
   * encore appliqué aux fichiers" and offers "Renvoyer", which sends the notice again.
   */

  interface Props {
    /** Bumped by the page after each load or save: the state is read again. */
    revision: number;
  }

  let { revision }: Props = $props();

  type Applied = { state: 'applied' | 'behind' | 'unreachable' };

  let applied = $state<Applied['state'] | null>(null);
  let resending = $state(false);
  let resendFailed = $state(false);

  const base = () => `${coreUrl()}/api/users/admin/platform/retention-applied`;

  async function read(init?: { method: 'POST' }): Promise<void> {
    const res = await apiFetch(init ? `${base()}/resend` : base(), init);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Applied;
    applied = body.state;
    Log.d(`admin.platform.retentionApplied state=${body.state}`);
  }

  $effect(() => {
    void revision;
    read().catch((e: unknown) => {
      Log.d('admin.platform.retentionApplied read failed', e);
      applied = 'unreachable';
    });
  });

  async function resend() {
    resending = true;
    resendFailed = false;
    try {
      await read({ method: 'POST' });
    } catch (e) {
      Log.d('admin.platform.retentionApplied resend failed', e);
      resendFailed = true;
    } finally {
      resending = false;
    }
  }
</script>

{#if applied === 'behind' || applied === 'unreachable'}
  <div class="space-y-2" role="status" data-retention-applied={applied}>
    <p class="text-amber-warn-text text-sm">
      {applied === 'behind'
        ? m.admin_platform_retention_not_applied()
        : m.admin_platform_retention_media_unreachable()}
    </p>
    <Button variant="secondary" size="compact" disabled={resending} onclick={() => void resend()}>
      <RefreshCw size={14} />
      {m.admin_platform_retention_resend()}
    </Button>
    {#if resendFailed}
      <p class="text-sm text-red-500" role="alert">{m.admin_platform_retention_resend_error()}</p>
    {/if}
  </div>
{/if}
