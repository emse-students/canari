<script lang="ts">
  import { Bell, BellOff, BellRing, ChevronDown } from '@lucide/svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import { showToast } from '$lib/stores/toast.svelte';
  import {
    bellOptions,
    getBellLevel,
    setBellLevel,
    type BellLevel,
    type BellTargetKind,
  } from '$lib/follows/bell';

  /**
   * THE BELL ON AN ACCOUNT (engagement WP-3, Instagram's): what the reader receives from this person
   * or entity - posts and lives, lives only, or nothing. Drawn by the app (`Picker`: a sheet on a
   * phone, a popover on a wide window), never a native select.
   *
   * The CALLER decides where it is offered (L7): on a person the reader follows (accepted), and on
   * any entity the reader sees, followed or not. It reads its level once mounted and writes on a
   * pick, optimistically: the trigger shows the new level at once and goes back if the server
   * refuses, with a toast that says so.
   */
  interface Props {
    kind: BellTargetKind;
    targetId: string;
  }

  let { kind, targetId }: Props = $props();

  let level = $state<BellLevel>('all');
  let loaded = $state(false);
  let saving = $state(false);
  const options = bellOptions();

  $effect(() => {
    const k = kind;
    const id = targetId;
    loaded = false;
    let stale = false;
    getBellLevel(k, id)
      .then((read) => {
        if (stale) return;
        level = read;
        loaded = true;
      })
      .catch((err: unknown) => {
        // The control stays disabled rather than showing a default that may be wrong.
        Log.d('AccountBell: level unreadable', err);
      });
    return () => {
      stale = true;
    };
  });

  async function choose(next: string) {
    const was = level;
    level = next as BellLevel;
    saving = true;
    try {
      level = await setBellLevel(kind, targetId, next as BellLevel);
    } catch (err) {
      Log.d('AccountBell.choose failed', err);
      level = was;
      showToast(m.bell_save_failed());
    } finally {
      saving = false;
    }
  }

  const Icon = $derived(level === 'none' ? BellOff : level === 'lives' ? BellRing : Bell);
</script>

<Picker
  value={level}
  {options}
  onValueChange={(v) => void choose(v)}
  label={m.bell_label()}
  disabled={!loaded || saving}
  triggerClass="ui-control bg-cn-surface text-text-main inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 py-1.5 text-base font-semibold transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10"
>
  {#snippet trigger(selected)}
    <span class="inline-flex items-center gap-2" data-testid="account-bell" data-level={level}>
      <Icon size={16} aria-hidden="true" />
      <span>{selected?.label ?? m.bell_label()}</span>
      <ChevronDown size={14} aria-hidden="true" class="text-text-muted" />
    </span>
  {/snippet}
</Picker>
