import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  POST_ATTACHMENTS_MAX,
  POST_ATTACHMENTS_TOO_MANY,
  assertWithinPostAttachmentCap,
} from './post-attachment-cap';

describe('post attachment cap', () => {
  it('equals libs/contracts/post-attachments.json', () => {
    const contract = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'post-attachments.json'),
        'utf8'
      )
    );
    expect(POST_ATTACHMENTS_MAX).toBe(contract.max);
    expect(POST_ATTACHMENTS_TOO_MANY).toBe(contract.code);
  });

  it('accepts 10 and refuses 11 with the typed code', () => {
    expect(() => assertWithinPostAttachmentCap(10)).not.toThrow();
    const refusal = () => {
      try {
        assertWithinPostAttachmentCap(11);
      } catch (e) {
        return e;
      }
      return undefined;
    };
    expect(refusal()).toBeInstanceOf(BadRequestException);
    expect((refusal() as BadRequestException).getResponse()).toMatchObject({
      code: POST_ATTACHMENTS_TOO_MANY,
      max: 10,
    });
  });

  it('lets a legacy post over the cap be edited down or kept, never grown', () => {
    expect(() => assertWithinPostAttachmentCap(12, 12)).not.toThrow();
    expect(() => assertWithinPostAttachmentCap(11, 12)).not.toThrow();
    expect(() => assertWithinPostAttachmentCap(13, 12)).toThrow(BadRequestException);
  });
});
