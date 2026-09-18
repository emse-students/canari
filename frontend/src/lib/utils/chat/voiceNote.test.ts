import { isVoiceNote } from './voiceNote';

/**
 * `isVoiceNote` decides whether an attachment is a TURN in the conversation or a FILE somebody
 * chose to send - two things made of identical bytes with an identical mime type.
 *
 * Every case here is about WHICH EVIDENCE is read and in which order: the sender's declaration
 * wherever there is one, and only otherwise the name the recorder itself wrote, which is all a
 * message predating the flag carries.
 */
describe('isVoiceNote', () => {
  describe('the sender declared it, and that is the whole answer', () => {
    it('is a voice note when declared one', () => {
      expect(isVoiceNote({ type: 'audio', voiceNote: true })).toBe(true);
    });

    it('is NOT a voice note when declared an import, even under the recorder name', () => {
      expect(
        isVoiceNote({ type: 'audio', voiceNote: false, fileName: 'vocal_1757900000000.m4a' })
      ).toBe(false);
    });

    it('reads the declaration even on a type the recorder cannot produce', () => {
      expect(isVoiceNote({ type: 'file', voiceNote: true })).toBe(true);
    });
  });

  describe('nothing was declared, so the recorder name is the only evidence', () => {
    it.each(['m4a', 'ogg', 'wav', 'webm'])(
      'recognises the name for a .%s recording',
      (extension) => {
        expect(isVoiceNote({ type: 'audio', fileName: `vocal_1757900000000.${extension}` })).toBe(
          true
        );
      }
    );

    it('is case-insensitive, because nothing here normalises an extension', () => {
      expect(isVoiceNote({ type: 'audio', fileName: 'VOCAL_1757900000000.M4A' })).toBe(true);
    });

    it('does not recognise a file a person named, however close', () => {
      for (const fileName of [
        'vocal.m4a',
        'vocal_.m4a',
        'mon vocal_1757900000000.m4a',
        'vocal_1757900000000.mp3',
        'vocal_1757900000000.m4a.txt',
        'repetition-vocale-1757900000000.m4a',
      ]) {
        expect(isVoiceNote({ type: 'audio', fileName })).toBe(false);
      }
    });

    it('keeps an attachment carrying no name at all - absent is unknown, never imported', () => {
      expect(isVoiceNote({ type: 'audio' })).toBe(false);
    });

    /**
     * THE TYPE STILL GATES THE NAME. The recorder only ever produces `audio`, so a document called
     * `vocal_<epoch>.m4a` reached the conversation some other way and is a file someone sent.
     */
    it('refuses the name on anything the recorder does not produce', () => {
      expect(isVoiceNote({ type: 'file', fileName: 'vocal_1757900000000.m4a' })).toBe(false);
    });
  });
});
