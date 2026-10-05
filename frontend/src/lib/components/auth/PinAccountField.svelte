<!--
  THE ACCOUNT A PIN BELONGS TO, FOR THE PASSWORD MANAGER AND NOBODY ELSE.

  Every PIN form here is a `<form>` with `type="password"` inputs and already asks the password
  manager to keep the PIN (`current-password` / `new-password`), but carried no username field - so
  Chrome printed "Password forms should have (optionally hidden) username fields" on each, and a
  manager had nothing to file the PIN under. The fix Chrome names is this one: a HIDDEN field with
  `autocomplete="username"`. It is not focusable, not announced, and never submitted to anything -
  `handleSubmit` in each form reads its own state, not the form data.

  One component for the three forms (`PinModal`, `ChangePinModal` in both variants), so the
  attributes that make it work are written once.
-->
<script lang="ts">
  interface Props {
    /** The signed-in account's id - what a password manager files the PIN under. Empty renders nothing. */
    account?: string;
  }

  let { account = '' }: Props = $props();
</script>

{#if account}
  <input
    type="text"
    name="username"
    autocomplete="username"
    value={account}
    hidden
    readonly
    tabindex="-1"
    aria-hidden="true"
    data-testid="pin-account-field"
  />
{/if}
