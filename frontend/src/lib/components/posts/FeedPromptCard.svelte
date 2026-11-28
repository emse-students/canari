<script lang="ts">
  import { X } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE QUIET PROMPT LINE AT THE TOP OF THE FEED (owner, 2026-11-10): one sentence, one action, a
   * cross. The birthday card and the Alumni link card are both this component, so the two look and
   * behave alike; what each says, when it is due and what "dismissed" records stay with its owner.
   */
  let {
    testid,
    title,
    actionLabel,
    onaction,
    ondismiss,
  }: {
    testid: string;
    title: string;
    actionLabel: string;
    onaction: () => void;
    ondismiss: () => void;
  } = $props();
</script>

<div
  class="border-cn-border bg-cn-surface mb-4 flex items-center gap-2 rounded-2xl border py-2 pr-2 pl-4"
  data-testid={testid}
>
  <p class="text-text-main min-w-0 flex-1 text-sm font-medium">{title}</p>
  <Button variant="secondary" size="compact" onclick={onaction}>{actionLabel}</Button>
  <Button
    variant="ghost"
    size="compact"
    icon
    aria-label={m.common_close_label()}
    onclick={ondismiss}
  >
    <X size={16} />
  </Button>
</div>
