import { describe, it, expect, vi } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { SocialApiError } from '$lib/associations/api';
import {
  QUESTION_IMAGE_MAX_BYTES,
  QuestionImageTooLargeError,
  QuestionImageTypeError,
  prepareQuestionImage,
  questionImageAlt,
  questionImageRefusalMessage,
  questionImageUploadError,
} from './questionImage';

const compressImage = vi.hoisted(() => vi.fn());
vi.mock('$lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/media')>()),
  compressImage,
}));

describe('prepareQuestionImage', () => {
  it('resizes with the post preset, the one every feed photo uses', async () => {
    const out = new File(['small'], 'q.webp', { type: 'image/webp' });
    compressImage.mockResolvedValueOnce({ file: out, width: 1600, height: 900 });
    const picked = new File(['big'], 'q.jpg', { type: 'image/jpeg' });
    expect(await prepareQuestionImage(picked)).toBe(out);
    expect(compressImage).toHaveBeenCalledWith(picked, 1600, 1600, 0.85);
  });

  it('refuses a type the public route cannot decode, before any work', async () => {
    compressImage.mockClear();
    await expect(
      prepareQuestionImage(new File(['g'], 'q.gif', { type: 'image/gif' }))
    ).rejects.toBeInstanceOf(QuestionImageTypeError);
    expect(compressImage).not.toHaveBeenCalled();
  });

  it('refuses a result still over the public ceiling', async () => {
    const heavy = new File([new Uint8Array(QUESTION_IMAGE_MAX_BYTES + 1)], 'q.png', {
      type: 'image/png',
    });
    compressImage.mockResolvedValueOnce({ file: heavy, width: 1600, height: 1600 });
    await expect(
      prepareQuestionImage(new File(['p'], 'q.png', { type: 'image/png' }))
    ).rejects.toBeInstanceOf(QuestionImageTooLargeError);
  });
});

describe('the sentences', () => {
  it('names each upload failure by its type, never by its message', () => {
    expect(questionImageUploadError(new QuestionImageTypeError('image/gif'))).toBe(
      m.form_builder_image_type_refused()
    );
    expect(questionImageUploadError(new QuestionImageTooLargeError(9))).toBe(
      m.form_builder_image_too_large()
    );
    expect(questionImageUploadError(new SocialApiError('x', null, 413))).toBe(
      m.form_builder_image_too_large()
    );
    expect(questionImageUploadError(new Error('Payload too large'))).toBe(
      m.form_builder_image_upload_failed()
    );
  });

  it("words the save's QUESTION_IMAGE_NOT_YOURS refusal, and nothing else", () => {
    expect(
      questionImageRefusalMessage(new SocialApiError('x', 'QUESTION_IMAGE_NOT_YOURS', 400))
    ).toBe(m.form_question_image_not_yours());
    expect(questionImageRefusalMessage(new SocialApiError('x', 'OTHER', 400))).toBeNull();
  });

  it('prefers the written alt, then names the question', () => {
    expect(questionImageAlt({ label: 'Plat', imageAlt: '  Le menu ' })).toBe('Le menu');
    expect(questionImageAlt({ label: 'Plat', imageAlt: '' })).toBe(
      m.form_question_image_alt({ label: 'Plat' })
    );
    expect(questionImageAlt({ label: '' })).toBe(
      m.form_question_image_alt({ label: m.form_question_untitled() })
    );
  });
});
