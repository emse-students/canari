import { describe, expect, it } from 'vitest';
import { FakeStream } from '../../test/mailFakes';
import {
  MAIL_HOST,
  ZimbraFault,
  ZimbraSoapClient,
  ZimbraUnreadableAnswer,
  readSoapAnswer,
  soapEnvelope,
} from './soapClient';

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Zimbra's answer to an unauthenticated GetInfo, as partage.emse.fr sends it (shape only). */
const AUTH_REQUIRED = JSON.stringify({
  Header: { context: { _jsns: 'urn:zimbra' } },
  Body: {
    Fault: {
      Code: { Value: 'soap:Sender' },
      Reason: { Text: 'no valid authtoken present' },
      Detail: { Error: { Code: 'service.AUTH_REQUIRED', _jsns: 'urn:zimbra' } },
    },
  },
  _jsns: 'urn:zimbraSoap',
});

function answer(status: number, json: string): string {
  const body = utf8(json);
  return `HTTP/1.1 ${status} X\r\nContent-Length: ${body.length}\r\n\r\n${json}`;
}

describe('readSoapAnswer', () => {
  it('types a fault by its Detail code, whatever the HTTP status', () => {
    try {
      readSoapAnswer(500, utf8(AUTH_REQUIRED));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ZimbraFault);
      expect((err as ZimbraFault).code).toBe('service.AUTH_REQUIRED');
      expect((err as ZimbraFault).status).toBe(500);
    }
  });

  it("answers a success's Body", () => {
    const body = readSoapAnswer(200, utf8('{"Body":{"GetInfoResponse":{"name":"x"}}}'));
    expect(body).toEqual({ GetInfoResponse: { name: 'x' } });
  });

  it('calls an HTML page, invalid UTF-8 or a non-200 without a fault unreadable', () => {
    expect(() => readSoapAnswer(502, utf8('<html>Bad gateway</html>'))).toThrow(
      ZimbraUnreadableAnswer
    );
    expect(() => readSoapAnswer(200, new Uint8Array([0x7b, 0xff, 0x7d]))).toThrow(
      ZimbraUnreadableAnswer
    );
    expect(() => readSoapAnswer(503, utf8('{"Body":{}}'))).toThrow(ZimbraUnreadableAnswer);
  });
});

describe('what a failure may carry into a log', () => {
  it("keeps the fault's Reason text and the unparsable body out of the error", () => {
    const quoting = JSON.stringify({
      Body: {
        Fault: {
          Reason: { Text: 'no such folder: Secret-Project' },
          Detail: { Error: { Code: 'mail.NO_SUCH_FOLDER' } },
        },
      },
    });
    const fault = (() => {
      try {
        readSoapAnswer(500, utf8(quoting));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(fault?.message).toBe('Zimbra fault mail.NO_SUCH_FOLDER (HTTP 500)');

    const garbled = (() => {
      try {
        readSoapAnswer(200, utf8('{"Body": private-words-here'));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(garbled).toBeInstanceOf(ZimbraUnreadableAnswer);
    expect(garbled?.message).not.toContain('private-words');
  });
});

describe('soapEnvelope', () => {
  it('carries the session token in the context header only when there is one', () => {
    expect(soapEnvelope({ A: {} })).toEqual({ Body: { A: {} } });
    expect(soapEnvelope({ A: {} }, 't')).toEqual({
      Header: { context: { _jsns: 'urn:zimbra', authToken: { _content: 't' } } },
      Body: { A: {} },
    });
  });
});

describe('ZimbraSoapClient', () => {
  /** A client over streams the test answers; `streams` lists every one it opened. */
  function client(respond: (stream: FakeStream, request: string) => void) {
    const streams: FakeStream[] = [];
    const soap = new ZimbraSoapClient(async () => {
      const stream = new FakeStream();
      stream.onWrite = (request) => respond(stream, request);
      streams.push(stream);
      return stream;
    });
    return { soap, streams };
  }

  it('posts the JSON envelope to /service/soap on the mailbox host', async () => {
    const { soap, streams } = client((s) => s.push(answer(200, '{"Body":{"R":{}}}')));
    await soap.call({ GetInfoRequest: { _jsns: 'urn:zimbraAccount' } });
    const request = streams[0].written[0];
    expect(request.startsWith('POST /service/soap HTTP/1.1\r\n')).toBe(true);
    expect(request).toContain(`\r\nHost: ${MAIL_HOST}\r\n`);
    expect(request.endsWith('{"Body":{"GetInfoRequest":{"_jsns":"urn:zimbraAccount"}}}')).toBe(
      true
    );
  });

  it('serves concurrent calls on ONE connection', async () => {
    const { soap, streams } = client((s) => s.push(answer(200, '{"Body":{"R":{}}}')));
    await Promise.all([soap.call({ A: {} }), soap.call({ B: {} }), soap.call({ C: {} })]);
    expect(streams).toHaveLength(1);
    expect(streams[0].written).toHaveLength(3);
  });

  it('rejects a fault typed, and keeps the connection', async () => {
    const { soap, streams } = client((s) => s.push(answer(500, AUTH_REQUIRED)));
    await expect(soap.call({ GetInfoRequest: {} })).rejects.toMatchObject({
      name: 'ZimbraFault',
      code: 'service.AUTH_REQUIRED',
    });
    await expect(soap.call({ GetInfoRequest: {} })).rejects.toBeInstanceOf(ZimbraFault);
    expect(streams).toHaveLength(1);
  });

  it('opens a new connection when the server ended the last one, and never re-sends', async () => {
    let n = 0;
    const { soap, streams } = client((s) => {
      n++;
      if (n === 2) {
        // The server dies mid-call: that call fails, and is not sent again.
        s.finish();
        return;
      }
      s.push(answer(200, '{"Body":{"R":{}}}'));
    });
    await soap.call({ A: {} });
    await expect(soap.call({ B: {} })).rejects.toMatchObject({ kind: 'ended' });
    await soap.call({ C: {} });
    expect(streams).toHaveLength(2);
    expect(streams[0].written).toHaveLength(2);
    expect(streams[1].written).toHaveLength(1);
  });

  it('re-sends a call that was NEVER SENT exactly once, on a fresh connection', async () => {
    const { soap, streams } = client((s) => {
      // The first connection answers its first call and says it closes: B, queued behind it,
      // never left, and goes out on the next connection.
      const close = streams.indexOf(s) === 0 ? 'Connection: close\r\n' : '';
      const json = '{"Body":{"R":{}}}';
      s.push(`HTTP/1.1 200 X\r\n${close}Content-Length: ${utf8(json).length}\r\n\r\n${json}`);
    });
    const [a, b] = await Promise.all([soap.call({ A: {} }), soap.call({ B: {} })]);
    expect(a).toEqual({ R: {} });
    expect(b).toEqual({ R: {} });
    expect(streams).toHaveLength(2);
    expect(streams[0].written).toHaveLength(1);
    expect(streams[1].written).toHaveLength(1);
    expect(streams[1].written[0]).toContain('"B":{}');
  });

  it('close ends the stream', async () => {
    const { soap, streams } = client((s) => s.push(answer(200, '{"Body":{"R":{}}}')));
    await soap.call({ A: {} });
    soap.close();
    expect(streams[0].ended).toBe(true);
  });
});
