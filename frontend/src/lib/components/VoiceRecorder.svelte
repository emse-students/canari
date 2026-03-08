<script lang="ts">
  import { Mic, Square, Trash2 } from 'lucide-svelte';
  import { onDestroy } from 'svelte';

  interface Props {
    onRecordingComplete: (audioBlob: Blob) => void;
    onCancel?: () => void;
  }

  let { onRecordingComplete, onCancel }: Props = $props();

  let isRecording = $state(false);
  let recordingDuration = $state(0);
  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let intervalId: number | null = null;

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // WebM with Opus is widely supported and efficient
      const options = { mimeType: 'audio/webm;codecs=opus' };
      mediaRecorder = new MediaRecorder(stream, options);

      audioChunks = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());

        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        onRecordingComplete(audioBlob);

        cleanup();
      };

      mediaRecorder.start();
      isRecording = true;
      recordingDuration = 0;

      intervalId = window.setInterval(() => {
        recordingDuration += 1;
      }, 1000);
    } catch (error) {
      console.error('Erreur accès micro:', error);
      alert("Impossible d'accéder au microphone. Vérifiez les permissions.");
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
      mediaRecorder.stop();
      audioChunks = []; // Clear chunks so onstop doesn't call onRecordingComplete
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
    class="w-11 h-11 text-gray-400 rounded-full flex items-center justify-center flex-shrink-0 hover:text-cn-dark hover:bg-gray-200 transition-colors"
    aria-label="Enregistrer un message vocal"
    title="Enregistrer un message vocal"
  >
    <Mic size={20} />
  </button>
{:else}
  <div class="flex items-center gap-2 px-3 py-2 bg-red-50 rounded-2xl border border-red-200">
    <div class="flex items-center gap-2">
      <div class="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
      <span class="text-sm font-mono text-red-700">{formatDuration(recordingDuration)}</span>
    </div>

    <button
      onclick={stopRecording}
      class="p-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
      aria-label="Arrêter l'enregistrement"
      title="Arrêter et envoyer"
    >
      <Square size={16} />
    </button>

    <button
      onclick={cancelRecording}
      class="p-1.5 rounded-lg text-gray-500 hover:bg-gray-200 transition-colors"
      aria-label="Annuler l'enregistrement"
      title="Annuler"
    >
      <Trash2 size={16} />
    </button>
  </div>
{/if}
