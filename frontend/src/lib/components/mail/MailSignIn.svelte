<script lang="ts">
  /**
   * THE SIGN-IN TO THE SCHOOL MAILBOX: THE PASSWORD, AND NOTHING ELSE TO TYPE
   * (owner, 2026-11-27; docs/wiki/mail-client-transport.md#as-built---lot-3).
   *
   * The address is the account's own (`MailContext.mailAddress`, MiConnect's `school_mail` claim),
   * shown, never a field. When this device does not know it yet - the ordinary state of an account
   * signed in before the claim existed - the screen says so, offers "Activer le mail" (the MiConnect
   * sign-in again) and no field at all - a typed address would sign
   * in to a mailbox the Canari identity never vouched for. "Retenir le mot de passe" is offered on
   * every platform with no warning (owner, D6): ticked, the password is sealed under the device key.
   */
  import { LockKeyhole, Mail, ShieldCheck } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { m } from '$lib/paraglide/messages';
  import { classifyMailFailure, type MailErrorKind } from '$lib/mail/mailErrors';
  import { mailAskText, mailErrorText } from '$lib/mail/mailErrorText';
  import type { PasswordAskReason } from '$lib/mail/mailSession';
  import { Log } from '$lib/utils/Log';

  interface Props {
    /** The account's own school address; `null` when this device has not been handed it. */
    address: string | null;
    /** Why the password is asked again, when it is. */
    reason: PasswordAskReason | null;
    /** Signs in; throws the typed failure. */
    onSignIn: (password: string, remember: boolean) => Promise<void>;
    /** "Activer le mail": runs the MiConnect sign-in again, which brings the school address. */
    onActivate: () => Promise<void>;
  }

  let { address, reason, onSignIn, onActivate }: Props = $props();
  let activating = $state(false);
  let activationFailed = $state(false);

  async function activate() {
    if (activating) return;
    Log.d('MAIL-UI', 'activation pressed');
    activating = true;
    activationFailed = false;
    try {
      await onActivate();
    } catch (err) {
      activationFailed = true;
      Log.w(
        'MAIL-UI',
        `ERROR: the MiConnect sign-in did not start (${classifyMailFailure(err).kind})`
      );
    } finally {
      activating = false;
    }
  }

  let password = $state('');
  let remember = $state(true);
  let busy = $state(false);
  let failure = $state<MailErrorKind | null>(null);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !password) return;
    Log.d('MAIL-UI', `sign-in submitted (remember: ${remember})`);
    busy = true;
    failure = null;
    try {
      await onSignIn(password, remember);
      password = '';
    } catch (err) {
      failure = classifyMailFailure(err).kind;
      Log.w('MAIL-UI', `sign-in failed (${failure})`);
    } finally {
      busy = false;
    }
  }
</script>

<div class="mx-auto flex w-full max-w-md flex-col gap-4 p-4" data-mail-signin>
  <section class="bg-cn-surface flex flex-col gap-4 rounded-2xl p-5">
    <span
      class="bg-accent text-on-accent flex h-14 w-14 items-center justify-center rounded-full"
      aria-hidden="true"
    >
      <Mail size={28} />
    </span>
    <div class="flex flex-col gap-1">
      <h2 class="font-display text-text-main text-xl font-semibold">{m.mail_signin_title()}</h2>
      <p class="text-text-muted text-sm">
        {address === null ? m.mail_signin_intro_pending() : m.mail_signin_intro()}
      </p>
    </div>

    {#if address === null}
      <!-- The ordinary state before the school address reaches Canari (the MiConnect claim), not a
           failure: worded as what will happen, drawn as information. -->
      <p class="text-text-main text-sm" role="status">{mailErrorText('address_unknown')}</p>
      <Button onclick={() => void activate()} loading={activating} data-mail-activate>
        <Mail size={18} aria-hidden="true" />
        {m.mail_activate()}
      </Button>
      {#if activationFailed}
        <p class="text-red-err text-sm" role="alert">{mailErrorText('internal')}</p>
      {/if}
    {:else}
      <form class="flex flex-col gap-4" onsubmit={submit}>
        {#if reason}
          <p class="text-amber-warn-text text-sm" role="status">{mailAskText(reason)}</p>
        {/if}
        <div class="flex flex-col gap-1">
          <span class="text-text-muted text-sm font-semibold">{m.mail_signin_address_label()}</span>
          <span class="text-text-main text-base font-semibold break-all" data-mail-address
            >{address}</span
          >
        </div>
        <Input
          type="password"
          label={m.mail_signin_password_label()}
          bind:value={password}
          autocomplete="current-password"
          error={failure ? mailErrorText(failure) : undefined}
          disabled={busy}
        />
        <label class="flex cursor-pointer items-start gap-3">
          <input type="checkbox" class="accent-accent mt-1 h-5 w-5" bind:checked={remember} />
          <span class="flex flex-col">
            <span class="text-text-main text-sm font-bold">{m.mail_signin_remember()}</span>
            <span class="text-text-muted text-xs">{m.mail_signin_remember_hint()}</span>
          </span>
        </label>
        <Button type="submit" loading={busy} disabled={!password}>
          <LockKeyhole size={18} aria-hidden="true" />
          {m.mail_signin_submit()}
        </Button>
      </form>
    {/if}
  </section>

  <section class="bg-cn-surface-alt flex gap-3 rounded-2xl p-4">
    <ShieldCheck size={22} class="text-text-main shrink-0" aria-hidden="true" />
    <div class="flex flex-col gap-1">
      <span class="text-text-main text-sm font-bold">{m.mail_privacy_title()}</span>
      <span class="text-text-muted text-sm">{m.mail_privacy_text()}</span>
    </div>
  </section>
</div>
