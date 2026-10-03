<script lang="ts">
  import GroupAvatar from './GroupAvatar.svelte';

  let imageMediaId = $state<string | null>('old');

  export function setImageMediaId(value: string | null): void {
    imageMediaId = value;
  }
</script>

<GroupAvatar {imageMediaId} name="Equipe" />
