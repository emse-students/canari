<script lang="ts">
  import LoginPage from '$lib/components/auth/LoginPage.svelte';
</script>

<!--
  The URL may carry an invite in its returnTo (a join page sends a signed-out reader here), so the page
  sends only its origin as Referer (strict-origin: no-referrer would outlive the page and make every
  same-origin POST carry `Origin: null`). The policy is a HEADER of this page
  (`$capability_referrer_policy`, Dockerfile.frontend); this <meta> restates it where no nginx answers -
  the Tauri app, a dev server - and for a client-side navigation here.
-->
<svelte:head>
  <meta name="referrer" content="strict-origin" />
</svelte:head>

<LoginPage />
