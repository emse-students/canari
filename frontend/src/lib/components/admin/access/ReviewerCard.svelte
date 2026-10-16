<script lang="ts">
  /**
   * ONE DOCUMENT REVIEWER: name, who authorized them and when, and a NAMED remove button - a bare
   * trash icon did not say what it removed (user, 2026-10-16). The confirmation is the panel's.
   */
  import { Trash2 } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    name: string;
    actorName: string;
    /** ISO date of the grant. */
    grantedAt: string;
    removing?: boolean;
    onRemove: () => void;
  }

  let { name, actorName, grantedAt, removing = false, onRemove }: Props = $props();
</script>

<li
  class="border-cn-border bg-cn-surface flex items-center gap-3 rounded-lg border px-4 py-3"
  data-testid="reviewer-card"
>
  <div class="min-w-0 flex-1">
    <p class="text-text-main truncate text-sm font-semibold">{name}</p>
    <p class="text-text-muted text-xs">
      {m.docreview_granted_by({
        date: new Date(grantedAt).toLocaleDateString(),
        actor: actorName,
      })}
    </p>
  </div>
  <button
    type="button"
    onclick={onRemove}
    disabled={removing}
    aria-label={m.docreview_revoke_aria({ name })}
    class="border-red-err/30 text-red-err hover:bg-red-err/10 inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50"
  >
    <Trash2 size={14} />
    {m.docreview_revoke_button()}
  </button>
</li>
