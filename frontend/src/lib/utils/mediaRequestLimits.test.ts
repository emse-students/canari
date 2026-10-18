import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertWithinRequestBudget,
  MEDIA_REQUEST_BODY_BUDGET_BYTES,
  RequestBodyTooLargeError,
  uploadFailureText,
} from './mediaRequestLimits';

afterEach(() => vi.restoreAllMocks());

function formOf(bytes: number): FormData {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(bytes)]), 'x.bin');
  return fd;
}

describe('assertWithinRequestBudget', () => {
  it('lets a body under 8 MiB through', () => {
    expect(() => assertWithinRequestBudget(formOf(1024))).not.toThrow();
  });

  it('refuses a body over 8 MiB with a typed, localised error, before any byte leaves', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fd = formOf(MEDIA_REQUEST_BODY_BUDGET_BYTES + 1);
    expect(() => assertWithinRequestBudget(fd)).toThrow(RequestBodyTooLargeError);
  });

  it('refuses a body whose size cannot be known', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertWithinRequestBudget(new ReadableStream())).toThrow(RequestBodyTooLargeError);
  });
});

describe('uploadFailureText', () => {
  it('shows the size refusal when the file is the cause, the generic line otherwise', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const big = new RequestBodyTooLargeError(9 * 1024 * 1024, MEDIA_REQUEST_BODY_BUDGET_BYTES);
    expect(uploadFailureText(big, 'generic')).toBe(big.message);
    expect(uploadFailureText(new Error('x'), 'generic')).toBe('generic');
  });
});
