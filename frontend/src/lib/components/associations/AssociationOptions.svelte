<!--
  THE OPTIONS OF EVERY ASSOCIATION SELECT, AND THE ONLY PLACE THAT DECIDES THEIR ORDER.

  NINE pickers let a user choose an association and each answered the same three questions for
  itself: are lists shown beside associations, in what order, and under what heading. Two grouped
  them and sorted them (`CreatePostForm`, `ProfileRoleHistorySection`), six rendered one flat run
  with lists mixed in - three of them sorting the fetch rather than the options - and one sorted
  nothing at all, so the same estate read differently depending on which door the user came through
  and a promo list could sit between two clubs with nothing saying it was a list (user, 2026-09-13:
  *"associations et listes sont melangees ... on pourrait afficher les unes puis les autres, comme
  dans la selection du parcours associatif dans /profile"*).

  This renders the OPTIONS only, never the `<select>`: the surrounding control is styled differently
  in a composer, a filter bar and a settings form, and that is a legitimate difference. What is not
  legitimate is each of them owning the grouping - so the grouping lives here, over
  `groupAssociationsForSelect`, which was already the shared answer and had two of the nine callers.

  A group with no members renders nothing, so a caller that fetched `listAssociations('association')`
  because lists cannot be its answer - a list's parent, the Cercle's billing target - keeps exactly
  the markup it had, with no flag to pass.
-->
<script lang="ts">
  import type { Association } from '$lib/associations/api';
  import { groupAssociationsForSelect, listOptionLabel } from '$lib/associations/selectGroups';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Associations and lists in any order - this component sorts and splits them. */
    associations: Association[];
    /** Classes applied to every `<option>`, for selects that style their menu. */
    optionClass?: string;
  }

  let { associations, optionClass = '' }: Props = $props();

  const grouped = $derived(groupAssociationsForSelect(associations));
</script>

{#if grouped.assos.length > 0}
  <optgroup label={m.asso_select_group_assos()}>
    {#each grouped.assos as a (a.id)}
      <option value={a.id} class={optionClass}>{a.name}</option>
    {/each}
  </optgroup>
{/if}
{#if grouped.lists.length > 0}
  <optgroup label={m.asso_select_group_lists()}>
    {#each grouped.lists as a (a.id)}
      <!-- The promo year rides on the label because two promos of one list share a name. -->
      <option value={a.id} class={optionClass}>{listOptionLabel(a)}</option>
    {/each}
  </optgroup>
{/if}
