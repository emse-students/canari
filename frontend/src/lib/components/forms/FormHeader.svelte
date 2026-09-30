<script lang="ts">
  import type { Form } from '$lib/forms/api';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import { Check, ClipboardList } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE HEAD OF A FORM BEING FILLED IN: its title, its banner when it has one, what it costs and what
   * it says about itself.
   *
   * The price badge was written twice inline - once over the banner, once beside the icon - so the
   * two layouts could say different things about one price. It is a snippet here, drawn in both.
   */
  interface Props {
    form: Pick<Form, 'title' | 'imageUrl' | 'description' | 'anonymous'>;
    /** The badge text, e.g. "A partir de 12 EUR (Cotisant)". Null when nothing is charged. */
    priceLabel: string | null;
    /** Draws the "already sent" tick beside the title. */
    submitted: boolean;
  }

  let { form, priceLabel, submitted }: Props = $props();
</script>

{#snippet priceBadge()}
  {#if priceLabel}
    <span
      class="bg-cn-yellow text-cn-ink mt-1.5 inline-block rounded-full px-2.5 py-1 text-xs font-bold"
    >
      {priceLabel}
    </span>
  {/if}
{/snippet}

<div class="border-cn-border mb-5 overflow-hidden rounded-3xl border bg-(--cn-surface) shadow-sm">
  {#if form.imageUrl}
    <div class="relative">
      <img src={form.imageUrl} alt="" class="max-h-72 w-full object-cover" loading="lazy" />
      <div
        class="absolute inset-x-0 bottom-0 h-28 bg-linear-to-t from-black/60 to-transparent"
      ></div>
      <div class="absolute inset-x-0 bottom-0 flex items-end gap-3 p-5">
        <div class="min-w-0 flex-1">
          <h1 class="text-2xl leading-tight font-bold text-white">{form.title}</h1>
          {@render priceBadge()}
        </div>
        {#if submitted}
          <div class="shrink-0 rounded-xl bg-green-500 p-2 text-white">
            <Check size={20} />
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <div
      class="from-cn-yellow/10 flex items-start gap-4 bg-linear-to-br via-transparent to-transparent px-6 pt-6 pb-4"
    >
      <div class="bg-cn-yellow/20 text-cn-dark shrink-0 rounded-2xl p-3">
        <ClipboardList size={26} />
      </div>
      <div class="min-w-0 flex-1">
        <h1 class="text-text-main text-2xl leading-tight font-bold">{form.title}</h1>
        {@render priceBadge()}
      </div>
      {#if submitted}
        <div class="bg-green-ok/15 text-green-ok shrink-0 rounded-xl p-2">
          <Check size={20} />
        </div>
      {/if}
    </div>
  {/if}
  {#if form.description?.trim()}
    <div class="border-cn-border/60 border-t px-6 py-4">
      <ProfileBioMarkdown source={form.description} />
    </div>
  {/if}
  {#if form.anonymous}
    <p class="border-cn-border/60 text-text-muted border-t px-6 py-3 text-xs">
      {m.form_view_anonymous_notice()}
    </p>
  {/if}
</div>
