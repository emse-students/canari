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
    type RetentionAppliedAnswer,
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
  /** Numbers every request and every resend ANSWER; see {@link show}. */
  let counter = 0;
  /** The number of the answer shown, 0 before any: an answer numbered lower is older, and dropped. */
  let shownSeq = 0;
  /** The state (and refusal) last logged, so a page view logs a CHANGE only, as core does. */
  let lastLogged: string | null = null;

  const base = () => `${coreUrl()}/api/users/admin/platform/retention-applied`;

  /** One request to core; resolves with an answer this page can word, else throws. */
  async function ask(resend: boolean): Promise<RetentionAppliedAnswer> {
    const res = await apiFetch(
      resend ? `${base()}/resend` : base(),
      resend ? { method: 'POST' } : undefined
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!isRetentionAppliedAnswer(body)) throw new Error('an answer this page cannot word');
    return body;
  }

  /**
   * Shows an answer unless a NEWER one is already shown - so a late answer to an older request never
   * replaces a newer one, while an older good answer still replaces nothing-yet or a failure. A shown
   * answer clears a previous resend's alert.
   */
  function show(answer: RetentionAppliedAnswer, seq: number) {
    if (seq <= shownSeq) {
      Log.d(`admin.platform.retentionApplied answer #${seq} is older than #${shownSeq}: dropped`);
      return;
    }
    shownSeq = seq;
    view = answer;
    resendFailed = false;
    const key = `${answer.state}:${answer.refusal?.reason ?? ''}:${answer.refusal?.status ?? ''}`;
    if (key === lastLogged) return;
    const first = lastLogged === null;
    lastLogged = key;
    if (answer.state !== 'applied') Log.w('admin.platform.retentionApplied', `state ${key}`);
    else if (!first) Log.i('admin.platform.retentionApplied', 'applied again');
  }

  /** Reads the state; a failure shows `failed` only while no answer was ever shown. */
  async function read() {
    const mine = ++counter;
    Log.d(`admin.platform.retentionApplied read #${mine}`);
    try {
      show(await ask(false), mine);
    } catch (e) {
      Log.w('admin.platform.retentionApplied', `read #${mine} failed: ${String(e)}`);
      // The last good answer stays: a failed re-read is no news about media-service.
      if (shownSeq === 0) view = { state: 'failed', refusal: null };
    }
  }

  $effect(() => {
    void revision;
    void read();
  });

  /**
   * "Renvoyer": core sends the notice, THEN reads the state. Its answer is numbered on ARRIVAL, so it
   * outranks every read that started before the notice completed - the state shown after a resend
   * comes from a read that began after it.
   */
  async function resend() {
    resending = true;
    resendFailed = false;
    try {
      const answer = await ask(true);
      show(answer, ++counter);
    } catch (e) {
      Log.w('admin.platform.retentionApplied', `resend failed: ${String(e)}`);
      resendFailed = true;
    } finally {
      resending = false;
    }
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
