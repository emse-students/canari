<script lang="ts">
  import { RefreshCw } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { coreUrl } from '$lib/utils/apiUrl';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import {
    isRetentionAppliedAnswer,
    retentionAppliedText,
    type RetentionAppliedView,
  } from '$lib/admin/retentionApplied';

  /**
   * Whether media-service stamps new conversation files with the retention durations saved on
   * /admin/platform (re-review of #3521, docs/wiki/retention-settings.md). Core compares what
   * media-service HOLDS with the columns - no timer, no retry: while they differ the page says "pas
   * encore appliqué aux fichiers" and offers "Renvoyer", which sends the notice again. What
   * media-service ANSWERED (a refusal, with its status) and what could not reach it are said apart,
   * and a failure of THIS page's own request claims nothing about media-service.
   */

  interface Props {
    /** Bumped by the page after each load or save: the state is read again. */
    revision: number;
  }

  let { revision }: Props = $props();

  let view = $state<RetentionAppliedView | null>(null);
  let resending = $state(false);
  let resendFailed = $state(false);
  /**
   * The number of the latest request: a load, a save's re-read and "Renvoyer" all write the state,
   * and only the LATEST one's answer may - an older answer arriving late is dropped.
   */
  let latest = 0;

  const base = () => `${coreUrl()}/api/users/admin/platform/retention-applied`;

  /** Reads the state (or re-sends, then reads); resolves false when this request failed. */
  async function read(resend: boolean): Promise<boolean> {
    const mine = ++latest;
    Log.d(`admin.platform.retentionApplied ${resend ? 'resend' : 'read'} #${mine}`);
    try {
      const res = await apiFetch(
        resend ? `${base()}/resend` : base(),
        resend ? { method: 'POST' } : undefined
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      if (!isRetentionAppliedAnswer(body)) throw new Error('an answer with no known state');
      if (mine !== latest) {
        Log.d(`admin.platform.retentionApplied #${mine} answered after #${latest}: dropped`);
        return true;
      }
      view = body;
      if (body.state !== 'applied') {
        Log.w('admin.platform.retentionApplied', `state=${body.state}`);
      }
      return true;
    } catch (e) {
      Log.w('admin.platform.retentionApplied', `request #${mine} failed: ${String(e)}`);
      if (mine === latest && !resend) view = { state: 'failed', refusal: null };
      return false;
    }
  }

  $effect(() => {
    void revision;
    void read(false);
  });

  async function resend() {
    resending = true;
    resendFailed = false;
    resendFailed = !(await read(true));
    resending = false;
  }

  const offersResend = $derived(
    view !== null && view.state !== 'applied' && view.state !== 'failed'
  );
</script>

{#if view && view.state !== 'applied'}
  <div class="space-y-2" role="status" data-retention-applied={view.state}>
    <p class="text-amber-warn-text text-sm">{retentionAppliedText(view)}</p>
    {#if offersResend}
      <Button variant="secondary" size="compact" disabled={resending} onclick={() => void resend()}>
        <RefreshCw size={14} />
        {m.admin_platform_retention_resend()}
      </Button>
    {/if}
    {#if resendFailed}
      <p class="text-red-err text-sm" role="alert">{m.admin_platform_retention_resend_error()}</p>
    {/if}
  </div>
{/if}
