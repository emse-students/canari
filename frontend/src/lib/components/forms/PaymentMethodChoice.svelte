<script lang="ts">
  import { m } from '$lib/paraglide/messages';

  /**
   * Online or cash, for a paid answer on a form that accepts cash - one control for both fill pages
   * (the member's `/forms/:id` and the guest's `/f/:id`), which would otherwise hold a copy each.
   * `online` is the wire value.
   */
  interface Props {
    method: 'online' | 'cash';
  }

  let { method = $bindable() }: Props = $props();
</script>

<div class="border-cn-border mt-4 rounded-2xl border bg-(--cn-surface) p-5">
  <p class="text-text-muted mb-3 text-xs font-bold tracking-wide uppercase">
    {m.form_view_payment_mode_heading()}
  </p>
  <div class="grid grid-cols-2 gap-2">
    <label
      class="flex cursor-pointer items-center gap-2.5 rounded-2xl border-2 px-4 py-3 transition-all select-none {method ===
      'online'
        ? 'border-cn-yellow bg-cn-yellow/8'
        : 'border-cn-border hover:border-cn-yellow/50'}"
    >
      <input type="radio" bind:group={method} value="online" class="accent-cn-yellow" />
      <span class="text-text-main text-sm font-semibold">{m.asso_achats_payment_online()}</span>
    </label>
    <label
      class="flex cursor-pointer items-center gap-2.5 rounded-2xl border-2 px-4 py-3 transition-all select-none {method ===
      'cash'
        ? 'border-cn-yellow bg-cn-yellow/8'
        : 'border-cn-border hover:border-cn-yellow/50'}"
    >
      <input type="radio" bind:group={method} value="cash" class="accent-cn-yellow" />
      <span class="text-text-main text-sm font-semibold">{m.asso_achats_payment_cash()}</span>
    </label>
  </div>
</div>
