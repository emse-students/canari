import {
  assertAnsweredByApi,
  NotFromApiError,
  readApiJson,
  refusalOrigin,
  responseOrigin,
} from './apiJson';
import { isTransportFailure } from './transportFailure';

/** WHO ANSWERED a 2xx, decided from the response's own facts - the content type, then a parse. */
describe('readApiJson', () => {
  const where = 'POST /api/x';

  it('returns the body the API wrote, whatever its shape', async () => {
    await expect(readApiJson(Response.json({ a: 1 }), where)).resolves.toEqual({ a: 1 });
    await expect(readApiJson(Response.json([1]), where)).resolves.toEqual([1]);
    await expect(readApiJson(Response.json(null), where)).resolves.toBeNull();
  });

  it('reads a 2xx without a JSON content type as no answer, and never reads its body', async () => {
    const res = new Response('<html>portal</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const failure = await readApiJson(res, where).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotFromApiError);
    expect(isTransportFailure(failure)).toBe(true);
    expect(failure).toMatchObject({ where, status: 200, contentType: 'text/html' });
    expect((failure as NotFromApiError).message).toBe(
      'POST /api/x answered 200 with text/html - not the API, read as no answer'
    );
  });

  it('reads a JSON content type whose body does not parse as no answer, carrying the parse error', async () => {
    const res = new Response('{"half', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const failure = await readApiJson(res, where).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotFromApiError);
    expect((failure as NotFromApiError).cause).toBeInstanceOf(SyntaxError);
  });

  it('reads an empty 2xx with no content type as no answer', async () => {
    const failure = await readApiJson(new Response(null, { status: 204 }), where).catch(
      (e: unknown) => e
    );
    expect(failure).toMatchObject({ name: 'NotFromApiError', contentType: null });
  });
});

describe('assertAnsweredByApi', () => {
  it("passes the API's JSON content type without reading the body", () => {
    const res = Response.json({ ok: true });
    expect(() => assertAnsweredByApi(res, 'x')).not.toThrow();
    expect(res.bodyUsed).toBe(false);
  });

  it('agrees with responseOrigin, the one reading of who answered', () => {
    const edge = new Response('x', { status: 200, headers: { 'content-type': 'text/plain' } });
    expect(responseOrigin(edge)).toBe('edge');
    expect(() => assertAnsweredByApi(edge, 'x')).toThrow(NotFromApiError);
  });
});

/**
 * WHO REFUSED, where the reading destroys something: Nest's envelope (`statusCode` equal to the
 * status) or a coded refusal of the shared contract, because an edge in front of the estate can
 * answer in JSON too.
 */
describe('refusalOrigin', () => {
  const json = (body: unknown, status: number) => Response.json(body, { status });

  it("reads Nest's own envelope as the gateway's", async () => {
    await expect(refusalOrigin(json({ statusCode: 403, message: 'Forbidden' }, 403))).resolves.toBe(
      'gateway'
    );
  });

  // `refusalBody(...)` thrown in an `HttpException` leaves as the object alone: no `statusCode`.
  it.each([
    ['NOT_A_MEMBER', 403],
    ['MEMBERSHIP_NOT_ALLOWED', 403],
    ['DEVICE_REVOKED', 403],
    ['USER_BLOCKED', 403],
    ['WELCOME_TARGET_NOT_MEMBER', 403],
  ])(
    "reads the coded refusal %s (the delivery service's refusalBody) as the gateway's",
    async (code, status) => {
      await expect(refusalOrigin(json({ code, message: 'm' }, status))).resolves.toBe('gateway');
    }
  );

  it("reads a code the shared contract does not know as the edge's, and a non-string one too", async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await expect(refusalOrigin(json({ code: 'ACCESS_DENIED', message: 'm' }, 403))).resolves.toBe(
      'edge'
    );
    await expect(refusalOrigin(json({ code: 'not_a_member' }, 403))).resolves.toBe('edge');
    await expect(refusalOrigin(json({ code: 403 }, 403))).resolves.toBe('edge');
    await expect(refusalOrigin(json(['NOT_A_MEMBER'], 403))).resolves.toBe('edge');
    await expect(refusalOrigin(json(null, 403))).resolves.toBe('edge');
    debug.mockRestore();
  });

  it("reads a CDN's JSON error (type, title, status, detail, error_code) as the edge's", async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const cdn = {
      type: 'about:blank',
      title: 'Blocked',
      status: 403,
      detail: 'd',
      error_code: 1020,
    };
    await expect(refusalOrigin(json(cdn, 403))).resolves.toBe('edge');
    debug.mockRestore();
  });

  // The gateway's own error pages imitate the envelope for 413/429/5xx: read as the gateway's, which
  // is why no destructive reader acts on those statuses (the readers' own tests hold that half).
  it('reads an envelope-imitating 5xx as the gateway origin it claims', async () => {
    await expect(
      refusalOrigin(json({ statusCode: 502, message: 'Bad Gateway' }, 502))
    ).resolves.toBe('gateway');
  });

  // The delivery service's 409 to a pending member: recognised so a label names its origin truly.
  it("reads the 409 awaiting_admission as the gateway's, and only on a 409", async () => {
    const body = {
      error: 'awaiting_admission',
      message: 'a member has not admitted this person yet',
    };
    await expect(refusalOrigin(json(body, 409))).resolves.toBe('gateway');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await expect(refusalOrigin(json(body, 403))).resolves.toBe('edge');
    await expect(refusalOrigin(json({ error: 'awaiting', message: 'm' }, 409))).resolves.toBe(
      'edge'
    );
    debug.mockRestore();
  });

  it("reads a JSON-speaking edge (a WAF or CDN block) as the edge's", async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await expect(
      refusalOrigin(json({ status: 403, title: 'Access denied', errors: [] }, 403))
    ).resolves.toBe('edge');
    // An envelope whose code is not the status it came with was not written for this answer.
    await expect(refusalOrigin(json({ statusCode: 401 }, 403))).resolves.toBe('edge');
    debug.mockRestore();
  });

  it("reads HTML, and a JSON type that does not parse, as the edge's", async () => {
    const html = new Response('<html/>', { status: 403, headers: { 'content-type': 'text/html' } });
    await expect(refusalOrigin(html)).resolves.toBe('edge');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const half = new Response('{"st', {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
    await expect(refusalOrigin(half)).resolves.toBe('edge');
    debug.mockRestore();
  });

  it('leaves the body readable for the caller', async () => {
    const res = json({ statusCode: 403, message: 'm' }, 403);
    await refusalOrigin(res);
    await expect(res.json()).resolves.toEqual({ statusCode: 403, message: 'm' });
  });
});
