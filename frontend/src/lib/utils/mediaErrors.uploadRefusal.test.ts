/**
 * AN ANSWER IS NEVER TRANSIENT (2026-10-10). The host WAF answered a 14 MB upload with a 403 HTML ban
 * page and the outbox retried it for ever as a "transient failure". The cause is read from the type
 * the throw carries - status and ORIGIN (the Content-Type), never the message.
 */
import { describe, expect, it } from 'vitest';
import { MediaUploadError, uploadRefusalCause, uploadRefusalFrom } from './mediaErrors';

const html = (status: number) =>
  new Response('<!DOCTYPE html><title>CrowdSec Ban</title>' + 'x'.repeat(5000), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
const json = (status: number) =>
  new Response('{"message":"no"}', { status, headers: { 'Content-Type': 'application/json' } });

describe('uploadRefusalFrom', () => {
  it('marks an HTML answer as the gateway and keeps its page out of the message', async () => {
    const err = await uploadRefusalFrom(html(403), 'media upload failed');
    expect(err.origin).toBe('gateway');
    expect(err.status).toBe(403);
    expect(err.message.length).toBeLessThan(200);
    expect(err.message).not.toContain('CrowdSec');
  });

  it('keeps a short excerpt of the application own JSON answer', async () => {
    const err = await uploadRefusalFrom(json(422), 'media upload failed');
    expect(err.origin).toBe('app');
    expect(err.message).toContain('"message":"no"');
  });
});

describe('uploadRefusalCause', () => {
  it.each([
    [new MediaUploadError(413, 'x'), 'too-large'],
    [new MediaUploadError(403, 'x', 'gateway'), 'blocked'],
    [new MediaUploadError(403, 'x'), 'refused'],
    [new MediaUploadError(404, 'x'), 'refused'],
    [new MediaUploadError(422, 'x'), 'refused'],
    [new MediaUploadError(429, 'x'), null],
    [new MediaUploadError(429, 'x', 'gateway'), null],
    [new MediaUploadError(408, 'x'), null],
    [new MediaUploadError(401, 'x'), null],
    [new MediaUploadError(500, 'x'), null],
    [new MediaUploadError(503, 'x', 'gateway'), null],
    [new TypeError('Network request failed'), null],
    [new Error('403 Forbidden'), null],
  ])('%#', (err, cause) => {
    expect(uploadRefusalCause(err)).toBe(cause);
  });
});
