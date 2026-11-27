<script lang="ts">
  /**
   * A STATE THE MAILBOX IS IN, SAID IN PLAIN WORDS (docs/wiki/mail-client-transport.md#as-built---lot-3):
   * a closed or unavailable account, maintenance, a network failure, an empty folder. One icon, one
   * sentence, and the remedy the sentence names - a retry only where the same press can succeed
   * (`mailErrorRetryable`), never a button that cannot help.
   */
  import type { Component, Snippet } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The glyph above the sentence. */
    Icon: Component<any>;
    title: string;
    text?: string;
    /** Shown as "Réessayer" when set. */
    onRetry?: () => void;
    /** A busy retry disables the button. */
    busy?: boolean;
    /** Extra actions under the sentence. */
    children?: Snippet;
    /** `error` reads as an alert to assistive technology; `info` as a plain status. */
    tone?: 'error' | 'info';
  }

  let { Icon, title, text, onRetry, busy = false, children, tone = 'info' }: Props = $props();
</script>

<div
  class="flex flex-col items-center gap-3 px-6 py-10 text-center"
  role={tone === 'error' ? 'alert' : 'status'}
  data-mail-state
>
  <span
    class="bg-cn-surface-alt text-text-muted flex h-14 w-14 items-center justify-center rounded-full"
    aria-hidden="true"
  >
    <Icon size={26} />
  </span>
  <p class="text-text-main text-base font-bold">{title}</p>
  {#if text}
    <p class="text-text-muted max-w-sm text-sm">{text}</p>
  {/if}
  {#if onRetry}
    <Button variant="secondary" onclick={onRetry} loading={busy}>{m.mail_retry()}</Button>
  {/if}
  {@render children?.()}
</div>
