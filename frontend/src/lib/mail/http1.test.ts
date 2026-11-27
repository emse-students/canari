import { describe, expect, it } from 'vitest';
import { FakeStream } from '../../test/mailFakes';
import { Http1Connection, HttpProtocolError, serializeRequest } from './http1';

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const utf8 = (s: string) => new TextEncoder().encode(s);

/** Feeds `bytes` to `stream` cut at every position in `cuts`, as the network would. */
function pushSplit(stream: FakeStream, bytes: Uint8Array, cuts: number[]): void {
  let from = 0;
  for (const cut of [...cuts, bytes.length]) {
    stream.push(bytes.subarray(from, cut));
    from = cut;
  }
}

describe('serializeRequest', () => {
  it('writes the request line, the Host, the headers and the BYTE length of the body', () => {
    const body = utf8('{"é":1}');
    const out = text(
      serializeRequest('partage.emse.fr', {
        method: 'POST',
        path: '/service/soap',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    );
    expect(out).toBe(
      'POST /service/soap HTTP/1.1\r\nHost: partage.emse.fr\r\nContent-Type: application/json\r\n' +
        `Content-Length: ${body.length}\r\n\r\n{"é":1}`
    );
    expect(body.length).toBe(8);
  });

  it('refuses a header that would inject a line', () => {
    expect(() =>
      serializeRequest('h', { method: 'GET', path: '/', headers: { X: 'a\r\nEvil: 1' } })
    ).toThrow(HttpProtocolError);
  });
});

describe('Http1Connection', () => {
  it('reads a Content-Length body split anywhere, multi-byte characters included', async () => {
    const body = utf8('{"Subject":"Réunion à 14h – café ☕"}');
    const head = utf8(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`);
    const whole = new Uint8Array([...head, ...body]);
    for (let cut = 1; cut < whole.length; cut++) {
      const stream = new FakeStream();
      const http = new Http1Connection(stream, 'h');
      const answer = http.request({ method: 'POST', path: '/', body: utf8('x') });
      pushSplit(stream, whole, [cut]);
      const response = await answer;
      expect(response.status).toBe(200);
      expect(text(response.body)).toBe('{"Subject":"Réunion à 14h – café ☕"}');
      expect(http.usable).toBe(true);
    }
  });

  it('reads a chunked body, its sizes counted in bytes, with trailers', async () => {
    const part1 = utf8('é'.repeat(3)); // 6 bytes, 3 characters
    const part2 = utf8('{}');
    const wire = new Uint8Array([
      ...utf8('HTTP/1.1 500 Internal Server Error\r\nTransfer-Encoding: chunked\r\n\r\n'),
      ...utf8(`${part1.length.toString(16)};ext=1\r\n`),
      ...part1,
      ...utf8('\r\n'),
      ...utf8(`${part2.length.toString(16)}\r\n`),
      ...part2,
      ...utf8('\r\n0\r\nX-Trailer: t\r\n\r\n'),
    ]);
    for (let cut = 1; cut < wire.length; cut += 3) {
      const stream = new FakeStream();
      const http = new Http1Connection(stream, 'h');
      const answer = http.request({ method: 'GET', path: '/' });
      pushSplit(stream, wire, [cut, Math.min(wire.length, cut + 7)]);
      const response = await answer;
      expect(response.status).toBe(500);
      expect(text(response.body)).toBe('ééé{}');
    }
  });

  it('serves several requests on one connection, each after the previous answer', async () => {
    const stream = new FakeStream();
    const http = new Http1Connection(stream, 'h');
    let n = 0;
    stream.onWrite = () => {
      n++;
      stream.push(`HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nr${n}`);
    };
    const [a, b, c] = await Promise.all([
      http.request({ method: 'POST', path: '/a', body: utf8('1') }),
      http.request({ method: 'POST', path: '/b', body: utf8('2') }),
      http.request({ method: 'POST', path: '/c', body: utf8('3') }),
    ]);
    expect([text(a.body), text(b.body), text(c.body)]).toEqual(['r1', 'r2', 'r3']);
    expect(stream.written.map((w) => w.split(' ')[1])).toEqual(['/a', '/b', '/c']);
  });

  it('is spent after a Connection: close answer, and after a body framed by the end', async () => {
    const closing = new FakeStream();
    const http = new Http1Connection(closing, 'h');
    const answer = http.request({ method: 'GET', path: '/' });
    closing.push('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    await answer;
    expect(http.usable).toBe(false);
    await expect(http.request({ method: 'GET', path: '/' })).rejects.toMatchObject({
      kind: 'ended',
    });

    const unframed = new FakeStream();
    const http2 = new Http1Connection(unframed, 'h');
    // The server answers once the request is sent, then ends the stream to frame the body.
    unframed.onWrite = () => {
      unframed.push('HTTP/1.1 200 OK\r\n\r\nall of');
      unframed.push(' it');
      unframed.finish();
    };
    expect(text((await http2.request({ method: 'GET', path: '/' })).body)).toBe('all of it');
    expect(http2.usable).toBe(false);
  });

  it('skips an interim 100 Continue', async () => {
    const stream = new FakeStream();
    const http = new Http1Connection(stream, 'h');
    const answer = http.request({ method: 'POST', path: '/', body: utf8('x') });
    stream.push('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n');
    expect((await answer).status).toBe(204);
  });

  it('says a stream that ends mid-body is ended, and garbage is malformed', async () => {
    const short = new FakeStream();
    short.onWrite = () => {
      short.push('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc');
      short.finish();
    };
    const answer = new Http1Connection(short, 'h').request({ method: 'GET', path: '/' });
    await expect(answer).rejects.toMatchObject({ name: 'HttpProtocolError', kind: 'ended' });
    // It was sent: the end came mid-body, not before the request.
    expect(short.written).toHaveLength(1);

    const garbage = new FakeStream();
    const http = new Http1Connection(garbage, 'h');
    const answer2 = http.request({ method: 'GET', path: '/' });
    garbage.push('SSH-2.0-OpenSSH\r\n\r\n');
    await expect(answer2).rejects.toMatchObject({ kind: 'malformed' });
    expect(http.usable).toBe(false);
  });
});
