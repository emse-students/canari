<script lang="ts">
  import { fade } from 'svelte/transition';
  import { ANONYMOUS_POST_IDENTITY } from '$lib/posts/postComposerDraft';
  import type { Association } from '$lib/associations/api';
  import { associationPickerOptions } from '$lib/associations/selectGroups';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import { getSavedDisplayName } from '$lib/stores/user';
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import AnonymousAvatar from '$lib/components/shared/AnonymousAvatar.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * WHO IS PUBLISHING, as the post composer and the CanaReels publish step both ask it: the avatar of
   * that identity, the choice itself drawn as the name, and the anonymous hint under it.
   *
   * One field for THREE kinds of identity: `''` (personal profile), `ANONYMOUS_POST_IDENTITY`
   * (anonymous), or a real association's UUID. They were a select plus a separate toggle - user
   * request, 2026-09-17, to fold "Anonyme" into the same "who is publishing" choice instead, and to
   * make that choice available to every user rather than only association admins. A reel is
   * published "with the same audience as posts have" (CanaReels R3), so the choice is ONE component
   * rather than a second copy in the camera.
   */
  interface Props {
    /** The associations the member may speak for (`postAsAssociations`). */
    associations: Association[];
    /** The chosen identity; bindable. */
    value?: string;
    /** The picker's element id, unique on the page. */
    id: string;
  }

  let { associations, value = $bindable(''), id }: Props = $props();

  const isAnonymousSelected = $derived(value === ANONYMOUS_POST_IDENTITY);
  const selectedAssociation = $derived(
    value && !isAnonymousSelected ? associations.find((a) => a.id === value) : undefined
  );

  /**
   * The personal option is labelled with the member's OWN NAME, because the select is drawn as the
   * author line ("Jolan Boudin" and a chevron, as Facebook heads its composer), and a heading that
   * read "Profil personnel" would say what kind of identity this is rather than whose.
   */
  const personalLabel = getSavedDisplayName() || m.post_create_personal_profile_label();

  /**
   * Who may publish, in the app's own picker: the member, anonymous, then the associations and lists
   * they may speak for, each with its avatar. It was a native `<select>`, which on Android opened
   * the system's dialog of bare names (user, 2026-09-29).
   */
  const identityOptions = $derived<PickerOption[]>([
    { value: '', label: personalLabel },
    { value: ANONYMOUS_POST_IDENTITY, label: m.post_create_anonymous_label() },
    ...associationPickerOptions(associations),
  ]);
</script>

<div class="flex items-center gap-3" data-post-identity>
  <div class="h-11 w-11 shrink-0">
    {#if isAnonymousSelected}
      <AnonymousAvatar fill />
    {:else if selectedAssociation}
      <AssociationAvatar
        fill
        shape="circle"
        name={selectedAssociation.name}
        logoUrl={selectedAssociation.logoUrl}
      />
    {:else if globalSession.userId}
      <Avatar fill userId={globalSession.userId} fallbackLabel={personalLabel} />
    {/if}
  </div>
  <div class="min-w-0">
    <Picker
      {id}
      {value}
      options={identityOptions}
      onValueChange={(v) => (value = v)}
      label={m.post_create_post_as_label()}
      triggerClass="text-text-main flex max-w-full items-center gap-1 rounded-lg py-1 pr-1.5 pl-1 text-base font-bold outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500/40 dark:hover:bg-white/10"
    >
      {#snippet leading(option)}
        <span class="block h-9 w-9">
          {#if option.value === ANONYMOUS_POST_IDENTITY}
            <AnonymousAvatar fill />
          {:else if option.value === ''}
            {#if globalSession.userId}
              <Avatar fill userId={globalSession.userId} fallbackLabel={personalLabel} />
            {/if}
          {:else}
            {@const asso = associations.find((a) => a.id === option.value)}
            <AssociationAvatar
              fill
              shape="circle"
              name={asso?.name ?? option.label}
              logoUrl={asso?.logoUrl}
            />
          {/if}
        </span>
      {/snippet}
    </Picker>
  </div>
</div>
{#if isAnonymousSelected}
  <p class="text-text-muted text-2xs mt-2" transition:fade={{ duration: 200 }}>
    {m.post_create_anonymous_hint()}
  </p>
{/if}
