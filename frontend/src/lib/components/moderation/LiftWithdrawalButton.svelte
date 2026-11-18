<script lang="ts">
  import { RotateCcw } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import Button from '$lib/components/ui/Button.svelte';
  import type { LiveWithdrawalLift } from '$lib/live/types';
  import { liftBroadcasterWithdrawal, LiveRefusalError } from '$lib/live/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { isTransportFailure } from '$lib/utils/transportFailure';
  import { describeModerationRefusal } from '$lib/moderation/moderationRefusal';

  /**
   * THE ONE LIFT CONTROL of a withdrawn right to broadcast, drawn on a reported live's block AND on
   * the list of withdrawn broadcasters (a withdrawal is a standing of the member, not of a report:
   * it must be liftable from where the standing is read, whatever the reports became).
   */
  interface Props {
    /** The withdrawn account. */
    userId: string;
    /** Their display name, for the confirmation; empty falls back to a neutral phrase. */
    name: string;
    /** Told after a lift (`lifted: false` is a repeat) so the caller reads its list again. */
    onLifted: (result: LiveWithdrawalLift) => void;
  }

  let { userId, name, onLifted }: Props = $props();

  let lifting = $state(false);
  let liftError = $state('');

  /** The sentence for a refused lift, decided on the typed code, never on a message. */
  function liftErrorText(e: unknown): string {
    // A refusal of the moderator's REACH (an institution's or a BDE's live, another BDE's spaces).
    const reach = describeModerationRefusal(e);
    if (reach) return reach;
    if (e instanceof LiveRefusalError) {
      if (e.code === 'LIVE_WITHDRAWAL_FORBIDDEN') return m.moderation_live_lift_forbidden();
      if (e.code === 'LIVE_ACCOUNT_INVALID') return m.moderation_live_withdraw_account_invalid();
    }
    return m.moderation_live_lift_error();
  }

  /**
   * Gives the account back the right to broadcast, after one confirmation naming them. A running
   * suspension is not lifted with it: the standing is derived from the cuts, which stay on record.
   */
  async function lift() {
    if (lifting) return;
    // Taken BEFORE the confirmation: a second tap while it is open must not open another one.
    lifting = true;
    const yes = await showConfirm(
      m.moderation_live_lift_prompt({ name: name || m.moderation_live_withdraw_this_account() }),
      { confirmLabel: m.moderation_live_lift_button() }
    );
    if (!yes) {
      console.debug(`[MODERATION] lift of ${userId}'s withdrawal declined`);
      lifting = false;
      return;
    }
    liftError = '';
    console.debug(`[MODERATION] lifting the withdrawal of ${userId}`);
    try {
      const result = await liftBroadcasterWithdrawal(userId);
      console.log(
        `[MODERATION] withdrawal of ${userId} ${result.lifted ? 'lifted' : 'was not there'}`
      );
      onLifted(result);
    } catch (e) {
      // A refusal is an answer (the server said no); no answer at all is a transport failure.
      console.warn(
        `[MODERATION] lifting the withdrawal of ${userId} failed${isTransportFailure(e) ? ' (no answer)' : ''}`,
        e
      );
      liftError = liftErrorText(e);
    } finally {
      lifting = false;
    }
  }
</script>

<Button
  variant="secondary"
  size="compact"
  onclick={() => void lift()}
  loading={lifting}
  data-moderation-live-lift
>
  <RotateCcw size={13} />
  {m.moderation_live_lift_button()}
</Button>
{#if liftError}
  <p class="text-red-err basis-full text-xs" role="alert" data-moderation-live-lift-error>
    {liftError}
  </p>
{/if}
