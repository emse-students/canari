<script lang="ts">
  /**
   * The person's MiConnect schooling as chips: every formation of their cursus, their posts and
   * their campus. Reads `cursus` only - `formation` is the first entry's shadow until WP6, so
   * showing both would say it twice.
   */
  import { GraduationCap } from '@lucide/svelte';
  import type { UserProfile } from '$lib/stores/user';
  import { campusLabel, postLabel } from '$lib/profile/miconnectProfile';

  let { profile }: { profile: Pick<UserProfile, 'cursus' | 'posts' | 'campus'> } = $props();

  const cursus = $derived(profile.cursus ?? []);
  const posts = $derived(profile.posts ?? []);
  const chip =
    'bg-cn-yellow/10 border-cn-yellow/20 text-cn-dark inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold tracking-wider uppercase shadow-sm';
</script>

{#if cursus.length || posts.length || profile.campus}
  <div class="mt-2 flex flex-wrap justify-center gap-2 sm:justify-start">
    {#each cursus as entry (entry.formation + entry.promo)}
      <div class={chip}>
        <GraduationCap size={14} strokeWidth={2.5} />
        {entry.formation}
      </div>
    {/each}
    {#each posts as post (post)}
      <div class={chip}>{postLabel(post)}</div>
    {/each}
    {#if profile.campus}
      <div class={chip}>{campusLabel(profile.campus)}</div>
    {/if}
  </div>
{/if}
