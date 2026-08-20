<script lang="ts">
  import { Mic, Square, Trash2 } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Callback fired with the recorded audio blob when the user stops recording. */
    onRecordingComplete: (audioBlob: Blob) => void;
    /** Optional callback invoked when the user cancels the recording. */
    onCancel?: () => void;
  }

  let { onRecordingComplete, onCancel }: Props = $props();

  let isRecording = $state(false);
  let recordingDuration = $state(0);
  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let intervalId: number | null = null;
  let isCancelling = false;

  // audio/mp4 is supported on both Android WebView and iOS WKWebView (webm is iOS-incompatible).
  const MIME_CANDIDATES = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];

  function pickRecorderMimeType(): string | undefined {
    for (const mime of MIME_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return undefined;
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mimeType = pickRecorderMimeType();
      mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      audioChunks = [];
      isCancelling = false;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());

        if (!isCancelling && audioChunks.length > 0) {
          const finalType = mediaRecorder?.mimeType || audioChunks[0]?.type || 'audio/webm';
          const audioBlob = new Blob(audioChunks, { type: finalType });
          onRecordingComplete(audioBlob);
        }

        cleanup();
      };

      mediaRecorder.start();
      isRecording = true;
      recordingDuration = 0;

      intervalId = window.setInterval(() => {
        recordingDuration += 1;
      }, 1000);
    } catch (error) {
      console.error('Mic access error:', error);
      showToast(m.chat_mic_permission_error());
      cleanup();
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }

  function cancelRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      isCancelling = true;
      mediaRecorder.stop();
    }
    cleanup();
    onCancel?.();
  }

  function cleanup() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    isRecording = false;
    recordingDuration = 0;
    mediaRecorder = null;
    audioChunks = [];
    isCancelling = false;
  }

  function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  onDestroy(() => {
    cleanup();
  });
</script>

{#if !isRecording}
  <button
    onclick={startRecording}
    class="text-cn-muted hover:text-cn-dark hover:bg-cn-bg flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors"
    aria-label={m.chat_record_voice_message_label()}
    title={m.chat_record_voice_message_title()}
  >
    <Mic size={20} />
  </button>
{:else}
  <div class="bg-red-err/10 border-red-err/30 flex items-center gap-2 rounded-2xl border px-3 py-2">
    <div class="flex items-center gap-2">
      <div class="h-2 w-2 animate-pulse rounded-full bg-red-500"></div>
      <span class="text-red-err font-mono text-sm">{formatDuration(recordingDuration)}</span>
    </div>

    <button
      onclick={stopRecording}
      class="rounded-lg bg-red-500 p-1.5 text-white transition-colors hover:bg-red-600"
      aria-label={m.chat_stop_recording_label()}
      title={m.chat_stop_and_send_title()}
    >
      <Square size={16} />
    </button>

    <button
      onclick={cancelRecording}
      class="text-cn-muted hover:bg-cn-bg rounded-lg p-1.5 transition-colors"
      aria-label={m.chat_cancel_recording_label()}
      title={m.common_cancel_button()}
    >
      <Trash2 size={16} />
    </button>
  </div>
{/if}
