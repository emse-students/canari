<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * WHAT A NEW LYDIA CASHIER READS (enrolment lot 3): reached from the `lydia_cashier_added` bell
   * row and from the association's "Caissiers" section. Static text only - what Lydia Pro is, the
   * SMS Lydia sends, the app to install, what each role allows, and who manages cashiers.
   */
</script>

<PageContainer width="tool">
  <PageHeader title={m.help_lydia_pro_title()} />
  <div class="text-text-main space-y-4 text-sm leading-relaxed">
    <p>{m.help_lydia_pro_what()}</p>
    <p>{m.help_lydia_pro_sms()}</p>
    <p>{m.help_lydia_pro_install()}</p>
    <h2 class="text-base font-bold">{m.help_lydia_pro_roles_title()}</h2>
    <ul class="list-disc space-y-1.5 pl-5">
      <li>{m.help_lydia_pro_role_responsable()}</li>
      <li>{m.help_lydia_pro_role_tresorier()}</li>
      <li>{m.help_lydia_pro_role_vendeur()}</li>
    </ul>
    <p class="text-text-muted">{m.help_lydia_pro_managers()}</p>
  </div>
</PageContainer>
