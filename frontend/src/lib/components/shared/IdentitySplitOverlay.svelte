<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { clearAuth, leaveSignedOut } from '$lib/stores/auth';
  import { getIdentitySplit } from '$lib/stores/tokenIdentity.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * The blocking notice for a token that names another account than this device's MLS identity
   * (see `tokenIdentity.svelte.ts`). One action only: the ordinary sign-out - `clearAuth()` then
   * `leaveSignedOut()`, the same two lines the navbar runs - which revokes the session and leaves the MLS
   * state untouched, so signing in as the RIGHT account restores everything. Not dismissible:
   * behind it every request would be refused.
   */
  const split = $derived(getIdentitySplit());
  let signingOut = $state(false);

  async function handleSignOut() {
    signingOut = true;
    try {
      console.warn('[AUTH] Sign-out from the identity-split notice - ending the session.');
      await clearAuth().catch((e) => console.error('[AUTH] Sign-out: clearAuth failed - ' + e));
      await leaveSignedOut();
    } finally {
      signingOut = false;
    }
  }
</script>

{#if split}
  <Modal
    open={true}
    title={m.identity_split_title()}
    dismissible={false}
    maxWidth="max-w-lg"
    onClose={() => {}}
  >
    <p class="text-text-muted text-sm leading-relaxed">{m.identity_split_body()}</p>

    {#snippet footer()}
      <Button class="w-full" disabled={signingOut} onclick={() => void handleSignOut()}>
        {m.identity_split_signout()}
      </Button>
    {/snippet}
  </Modal>
{/if}
