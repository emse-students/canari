import { assertAnsweredByApi, NotFromApiError, readApiJson, responseOrigin } from './apiJson';
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
