<script lang="ts">
  import { format } from 'date-fns';
  import { fly } from 'svelte/transition';

  interface Props {
    senderId: string;
    content: string;
    timestamp: Date;
    isOwn: boolean;
  }

  let { senderId: _senderId, content, timestamp, isOwn }: Props = $props();
</script>

<div class="flex w-full {isOwn ? 'justify-end' : 'justify-start'}">
  <div
    in:fly={{ y: 5, duration: 200 }}
    class="max-w-[75%] px-5 py-3 rounded-[1.25rem] {isOwn
      ? 'bg-cn-yellow text-cn-dark rounded-br-sm'
      : 'bg-white text-cn-dark border border-cn-border rounded-bl-sm'}"
  >
    <p class="text-base leading-relaxed break-words">{content}</p>
    <span class="block text-[0.65rem] mt-2 text-right opacity-70">
      {format(timestamp, 'HH:mm')}
    </span>
  </div>
</div>
