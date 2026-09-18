import type { MediaRef } from '$lib/media';

/**
 * The name the composer's recorder generates, and the ONLY evidence a message sent before
 * 2026-09-17 carries.
 *
 * `ChatComposer.handleVoiceRecording` writes `vocal_<epoch>.<ext>` with the extension chosen from
 * the recorder's own mime type, so the four spellings here are the complete set it can produce.
 */
const RECORDER_FILE_NAME = /^vocal_\d+\.(?:m4a|ogg|wav|webm)$/i;

/**
 * Whether this attachment is a VOICE NOTE - a turn in the conversation - rather than a file
 * somebody chose to send.
 *
 * ## Why it is not the mime type
 *
 * A recording and an imported `.m4a` are the same bytes with the same mime type. Nothing in the
 * attachment distinguishes them, which is why the SENDER declares it: `MediaRef.voiceNote`, shipped
 * 2026-09-17. Where that flag is present it is the whole answer, and `ChatComposer.isAudioFile`
 * refuses to read the name for the same reason.
 *
 * ## Why the name is read anyway, and only here
 *
 * The flag was added to a format that had already been in use for months, and **absent was treated
 * as unknown** - deliberately, so that an imported audio file would not be hidden by a guess. The
 * consequence reached the user the next day (`G10`, 2026-09-18): every voice note recorded before
 * the flag existed was still listed under `Fichiers`, under its generated name, burying the files
 * people had actually sent each other.
 *
 * Such a message carries exactly one piece of evidence, and it is the name the recorder itself
 * wrote. Reading it is not a guess about an unknown format - it is a read of a KNOWN one, and a
 * name no chooser produces: `vocal_`, an epoch in digits, and one of the four extensions the
 * recorder can emit.
 *
 * **AND IT DECIDES EVERY UNDECLARED AUDIO, NOT ONLY THE OLD ONES.** The wire carries the flag
 * `true | undefined` and never `false` (`envelope.ts:238` emits it only when true), so an import is
 * ALWAYS undeclared - there is no "declared an import" state to protect it. `voiceNote === false`
 * is honoured here anyway because a caller holding a local `MediaRef` can hold one, but nothing
 * arriving over the wire ever will.
 *
 * So the cost of being wrong is real, and small in one direction only: an audio file a person
 * happened to name `vocal_<digits>.<ext>` is hidden from a tab. Nothing is deleted and the message
 * is untouched - it plays in the conversation either way.
 */
export function isVoiceNote(media: Pick<MediaRef, 'type' | 'voiceNote' | 'fileName'>): boolean {
  if (media.voiceNote !== undefined) return media.voiceNote;
  return media.type === 'audio' && RECORDER_FILE_NAME.test(media.fileName ?? '');
}
