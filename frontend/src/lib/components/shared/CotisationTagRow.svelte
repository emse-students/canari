<script lang="ts">
  import type { Snippet } from 'svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { formatCotisationTag, resolveIssuingAssociation } from '$lib/associations/cotisationTag';
  import type { Association, UserTag } from '$lib/associations/api';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  interface Props {
    /** The cotisation tag to render. */
    tag: UserTag;
    /** Trailing content, typically an "Active" status badge. */
    trailing?: Snippet;
    /** Extra muted note appended to the subtitle (e.g. holder name in admin views). */
    note?: string;
  }

  let { tag, trailing, note }: Props = $props();

  // Friendly slug parse is synchronous and always available; the association
  // (name + logo) is resolved lazily and enriches the row once it arrives.
  const fmt = $derived(formatCotisationTag(tag.tagName));
  let assoc = $state<Association | null>(null);

  $effect(() => {
    const id = tag.issuingAssocId;
    let cancelled = false;
    assoc = null;
    void resolveIssuingAssociation(id).then((a) => {
      if (!cancelled) assoc = a;
    });
    return () => {
      cancelled = true;
    };
  });

  // Prefer the real association name; fall back to the friendly slug label.
  const title = $derived(assoc?.name ?? m.cotisation_tag_label({ acronym: fmt.acronym }));
  // Duration: explicit expiry wins, then the slug's academic-year period, else permanent.
  const duration = $derived(
    tag.expiresAt
      ? m.cotisation_tag_expires_at({
          date: new Date(tag.expiresAt).toLocaleDateString(
            getLocale() === 'en' ? 'en-US' : 'fr-FR'
          ),
        })
      : (fmt.period ?? m.cotisation_tag_permanent())
  );
</script>

<AssociationAvatar name={assoc?.name ?? fmt.acronym} logoUrl={assoc?.logoUrl} size="md" />
<div class="min-w-0 flex-1">
  <p class="text-sm font-bold text-text-main truncate">{title}</p>
  <p class="text-xs text-text-muted mt-0.5 truncate">
    {#if assoc}{m.cotisation_tag_role()} &middot;
    {/if}{duration}{#if note}
      &middot; {note}{/if}
  </p>
</div>
{#if trailing}{@render trailing()}{/if}
