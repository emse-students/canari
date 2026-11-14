<script lang="ts">
  import { m } from '$lib/paraglide/messages';

  /**
   * WHERE A PAYMENT WENT, for a payer the https return left in the phone's browser with no Canari
   * session: it was handed to Lydia, its confirmation is in the app, and the link is the app's own
   * (`fr.emse.canari://payment/success...`), which a TAP may open where a redirect could not. One
   * notice for the login page (a form return) and the shop page (a purchase return).
   */
  let { href }: { href: string } = $props();
</script>

<div
  role="status"
  data-payment-return
  class="border-cn-border bg-cn-border/20 text-text-main rounded-xl border px-4 py-3 text-sm"
>
  <p class="font-bold">{m.form_payment_handed_heading()}</p>
  <p class="text-text-muted mt-1">{m.form_payment_handed_desc()}</p>
  <a {href} class="text-accent-text mt-2 inline-block font-semibold underline"
    >{m.form_payment_open_canari()}</a
  >
</div>
