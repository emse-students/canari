/**
 * AN ANSWER IS NEVER TRANSIENT (2026-10-10). The host WAF answered a 14 MB upload with a 403 HTML ban
 * page and the outbox retried it for ever as a "transient failure". The cause is read from the type
 * the throw carries - status and ORIGIN (the Content-Type), never the message.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_REEL_OVER_BUDGET,
  isOverBudgetBody,
  MediaUploadError,
  uploadRefusalCause,
  uploadRefusalFrom,
} from './mediaErrors';

const html = (status: number) =>
  new Response('<!DOCTYPE html><title>CrowdSec Ban</title>' + 'x'.repeat(5000), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
const json = (status: number) =>
  new Response('{"message":"no"}', { status, headers: { 'Content-Type': 'application/json' } });

describe('uploadRefusalFrom', () => {
  it('marks an HTML answer as the edge and keeps its page out of the message', async () => {
    const err = await uploadRefusalFrom(html(403), 'media upload failed');
    expect(err.origin).toBe('edge');
    expect(err.status).toBe(403);
    expect(err.message.length).toBeLessThan(200);
    expect(err.message).not.toContain('CrowdSec');
  });

  it("reads media-service's daily chat-reel budget from the CODE its 429 carries, never the message", async () => {
    const budget = new Response(
      JSON.stringify({ statusCode: 429, message: 'anything', code: CHAT_REEL_OVER_BUDGET }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
    const err = await uploadRefusalFrom(budget, 'chunked upload init failed');
    expect(err.overBudget).toBe(true);
    expect(uploadRefusalCause(err)).toBe('over-budget');
    // A 429 with no code (an open-session limit) and an edge 429 stay transient.
    expect((await uploadRefusalFrom(json(429), 'x')).overBudget).toBe(false);
    expect(uploadRefusalCause(await uploadRefusalFrom(html(429), 'x'))).toBeNull();
    expect(isOverBudgetBody('Daily chat-reel upload budget reached.')).toBe(false);
  });

  it('keeps a short excerpt of the application own JSON answer', async () => {
    const err = await uploadRefusalFrom(json(422), 'media upload failed');
    expect(err.origin).toBe('gateway');
    expect(err.message).toContain('"message":"no"');
  });
});

describe('uploadRefusalCause', () => {
  it.each([
    [new MediaUploadError(413, 'x'), 'too-large'],
    [new MediaUploadError(403, 'x', 'edge'), 'blocked'],
    [new MediaUploadError(404, 'x', 'edge'), null],
    [new MediaUploadError(400, 'x', 'edge'), null],
    [new MediaUploadError(502, 'x', 'edge'), null],
    [new MediaUploadError(409, 'x'), null],
    [new MediaUploadError(400, 'x'), 'refused'],
    [new MediaUploadError(404, 'x', 'gateway', true), null],
    [new MediaUploadError(403, 'x'), 'refused'],
    [new MediaUploadError(404, 'x'), 'refused'],
    [new MediaUploadError(422, 'x'), 'refused'],
    [new MediaUploadError(429, 'x'), null],
    [new MediaUploadError(429, 'x', 'gateway', false, true), 'over-budget'],
    [new MediaUploadError(429, 'x', 'edge'), null],
    [new MediaUploadError(408, 'x'), null],
    [new MediaUploadError(401, 'x'), null],
    [new MediaUploadError(500, 'x'), null],
    [new MediaUploadError(503, 'x', 'edge'), null],
    [new TypeError('Network request failed'), null],
    [new Error('403 Forbidden'), null],
  ])('%#', (err, cause) => {
    expect(uploadRefusalCause(err)).toBe(cause);
  });
});
