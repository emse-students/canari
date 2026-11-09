/**
 * The post API's one request helper types what came back AT THE THROW: a 2xx that is not JSON (a
 * captive portal's page, an edge's) is the edge's answer, never the `SyntaxError` of `json()` - which
 * the publish queue read as a refusal and stopped a post on (review of #3061).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';

const answer = vi.hoisted(() => ({ res: null as Response | null }));
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: vi.fn(async () => answer.res) }));

import { socialRequest } from './api';
import { classifyPublishFailure } from './publishQueue/publishQueue';

describe('socialRequest', () => {
  beforeEach(() => {
    answer.res = null;
  });

  it("answers the app's JSON", async () => {
    answer.res = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await expect(socialRequest('/api/posts')).resolves.toEqual({ ok: true });
  });

  it('throws a 2xx HTML page as an EDGE answer, which the publish queue waits out', async () => {
    answer.res = new Response('<html>Wi-Fi login</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const error = await socialRequest('/api/posts').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRefusalError);
    expect((error as ApiRefusalError).origin).toBe('edge');
    expect(classifyPublishFailure(error)).toBe('wait');
  });
});
