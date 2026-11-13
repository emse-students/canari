<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { Plus } from '@lucide/svelte';
  import { getForms, type Form } from '$lib/forms/api';
  import { m } from '$lib/paraglide/messages';
  import Button from '$lib/components/ui/Button.svelte';
  import FormsManagerList from '$lib/components/forms/FormsManagerList.svelte';

  /** The list's own count, told by the list as it loads and as a form is deleted. */
  let count = $state(0);

  function onForms(forms: Form[]) {
    count = forms.length;
  }
</script>

<!-- `tool` and not the default `reading`: the list opens the responses TABLE, which `pageWidth.ts`
     names as the shape that width exists for, and it is the width its own two editor pages already
     use. The list itself is `FormsManagerList`, the SAME component an association's "Formulaires"
     tab draws, over this caller's every form (owned, or managed through an association). -->
<PageContainer width="tool">
  <PageHeader
    title={m.form_list_title()}
    subtitle={count === 1 ? m.form_list_count_one() : m.form_list_count({ count })}
  >
    {#snippet actions()}
      <Button href="/forms/create">
        <Plus size={16} />
        {m.form_list_new_button()}
      </Button>
    {/snippet}
  </PageHeader>

  <FormsManagerList load={getForms} createHref="/forms/create" {onForms} />
</PageContainer>
