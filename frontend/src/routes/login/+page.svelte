<script lang="ts">
  import LoginPage from '$lib/components/auth/LoginPage.svelte';
</script>

<!--
  The URL may carry an invite in its returnTo (a join page sends an unsigned-in reader here), so the
  page sends no Referer. The policy is a response HEADER of this page (`$capability_referrer_policy`,
  Dockerfile.frontend); this <meta> restates it where no nginx answers - the Tauri app, a dev server -
  and for a client-side navigation here, which no header reaches.
-->
<svelte:head>
  <meta name="referrer" content="no-referrer" />
</svelte:head>

<LoginPage />
