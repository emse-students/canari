import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { m } from '$lib/paraglide/messages';
import {
  POST_ATTACHMENTS_MAX,
  POST_ATTACHMENTS_TOO_MANY,
  admitAttachments,
  attachmentCapNotice,
  attachmentsFull,
} from './attachmentCap';

describe('the post attachment cap', () => {
  it('equals libs/contracts/post-attachments.json, the server reads the same file', () => {
    const contract = JSON.parse(
      readFileSync(join(process.cwd(), '..', 'libs', 'contracts', 'post-attachments.json'), 'utf8')
    );
    expect(POST_ATTACHMENTS_MAX).toBe(contract.max);
    expect(POST_ATTACHMENTS_TOO_MANY).toBe(contract.code);
  });

  it('takes everything while it fits, with no notice', () => {
    const admitted = admitAttachments(4, ['a', 'b']);
    expect(admitted).toEqual({ accepted: ['a', 'b'], leftOut: 0 });
    expect(attachmentCapNotice(admitted)).toBeNull();
  });

  it('takes as many as fit, in order, and counts the rest', () => {
    const admitted = admitAttachments(8, ['a', 'b', 'c', 'd']);
    expect(admitted).toEqual({ accepted: ['a', 'b'], leftOut: 2 });
    expect(attachmentCapNotice(admitted)).toBe(
      m.post_attachments_partial({ taken: 2, leftOut: 2, max: POST_ATTACHMENTS_MAX })
    );
  });

  it('takes nothing once full, and says the post is full', () => {
    expect(attachmentsFull(10)).toBe(true);
    expect(attachmentsFull(9)).toBe(false);
    const admitted = admitAttachments(12, ['a']);
    expect(admitted).toEqual({ accepted: [], leftOut: 1 });
    expect(attachmentCapNotice(admitted)).toBe(
      m.post_attachments_full({ max: POST_ATTACHMENTS_MAX })
    );
  });
});
