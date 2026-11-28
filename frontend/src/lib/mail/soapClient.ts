import { Log } from '$lib/utils/Log';
import { Http1Connection, type HttpRequest, type HttpResponse } from './http1';
import type { PlaintextStream } from './tlsConnection';
import { MailTransportError } from './transport';

/**
 * ZIMBRA JSON SOAP OVER THE MAIL CLIENT'S OWN TLS (docs/wiki/mail-client.md D2).
 *
 * One persistent connection serves every call; when the server ends it (keep-alive expiry, the
 * relay's idle bound) the NEXT call opens a new one. A call is never re-sent on its own: `SendMsg`
 * is not idempotent, and a call whose connection died mid-flight may have been carried out.
 */

/** The mailbox host: the `Host` header, and the one name the TLS certificate must carry. */
export const MAIL_HOST = 'partage.emse.fr';
/** Zimbra's SOAP endpoint, JSON flavour. */
const SOAP_PATH = '/service/soap';

/**
 * A Zimbra fault, typed by its `Code` (`service.AUTH_REQUIRED`, `account.AUTH_FAILED`, ...).
 *
 * Its message carries the code and the status ONLY. The fault's `Reason.Text` is server prose that
 * can quote what the call carried (an address, a folder name, a search), and an error message is
 * what ends up in a log line, so the text is never kept.
 */
export class ZimbraFault extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(`Zimbra fault ${code} (HTTP ${status})`);
    this.name = 'ZimbraFault';
  }
}

/** An answer that is neither a SOAP body nor a SOAP fault: the server, or what stands in for it. */
export class ZimbraUnreadableAnswer extends Error {
  constructor(
    readonly status: number,
    detail: string
  ) {
    super(`Zimbra answered HTTP ${status} with no readable SOAP envelope: ${detail}`);
    this.name = 'ZimbraUnreadableAnswer';
  }
}

/** The envelope of one call, with the session token when there is one. */
export function soapEnvelope(body: Record<string, unknown>, authToken?: string): unknown {
  return authToken
    ? {
        Header: { context: { _jsns: 'urn:zimbra', authToken: { _content: authToken } } },
        Body: body,
      }
    : { Body: body };
}

interface FaultShape {
  Code?: { Value?: string };
  Detail?: { Error?: { Code?: string } };
}

/**
 * Reads a Zimbra answer: the `Body` of a success, or a {@link ZimbraFault} carrying the fault's
 * `Detail.Error.Code` (Zimbra answers a fault with HTTP 500 and a JSON body, so the status alone
 * says nothing). The JSON is decoded from the WHOLE body's bytes.
 */
export function readSoapAnswer(status: number, body: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch (err) {
    // The parser's text quotes the input around the fault: only its class and the length are kept.
    const kind = err instanceof Error ? err.name : typeof err;
    throw new ZimbraUnreadableAnswer(status, `not JSON (${body.length} bytes, ${kind})`);
  }
  const envelopeBody = (parsed as { Body?: Record<string, unknown> } | null)?.Body;
  if (!envelopeBody || typeof envelopeBody !== 'object') {
    throw new ZimbraUnreadableAnswer(status, 'no Body');
  }
  const fault = envelopeBody.Fault as FaultShape | undefined;
  if (fault) {
    const code = fault.Detail?.Error?.Code ?? fault.Code?.Value ?? 'unknown';
    throw new ZimbraFault(code, status);
  }
  if (status !== 200) {
    throw new ZimbraUnreadableAnswer(status, 'a non-200 answer without a Fault');
  }
  return envelopeBody;
}

/** Opens a new plaintext stream to the mailbox (a TLS connection over a transport). */
export type StreamOpener = () => Promise<PlaintextStream>;

/** Zimbra SOAP calls over one persistent connection, reopened when the server ended it. */
export class ZimbraSoapClient {
  private connection: Http1Connection | null = null;
  private stream: PlaintextStream | null = null;
  /** The open in flight, shared by every call that needs a connection meanwhile: one, never two. */
  private opening: Promise<Http1Connection> | null = null;
  /** Moved by {@link close}: an open that resolves after it belongs to a closed client. */
  private generation = 0;

  constructor(private readonly openStream: StreamOpener) {}

  /** Calls Zimbra with `body` (`{ GetInfoRequest: {...} }`), resolving with the answer's `Body`. */
  async call(body: Record<string, unknown>, authToken?: string): Promise<Record<string, unknown>> {
    const request = Object.keys(body).join(',');
    const payload = new TextEncoder().encode(JSON.stringify(soapEnvelope(body, authToken)));
    Log.d('MAIL-SOAP', `${request} (${payload.length} bytes)`);
    const response = await this.exchange({
      method: 'POST',
      path: SOAP_PATH,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
      body: payload,
    });
    try {
      const answer = readSoapAnswer(response.status, response.body);
      Log.d('MAIL-SOAP', `${request} answered`);
      return answer;
    } catch (err) {
      if (err instanceof ZimbraFault) Log.d('MAIL-SOAP', `${request} fault ${err.code}`);
      else Log.w('MAIL-SOAP', `${request} unreadable`, err);
      throw err;
    }
  }

  /**
   * One plain HTTP exchange on the SAME connection as the SOAP calls - the upload servlet and the
   * attachment download are HTTP/1.1 on the same host, so they need no second client. Never re-sent,
   * for the same reason as {@link call}.
   */
  async exchange(request: HttpRequest): Promise<HttpResponse> {
    const connection = await this.usableConnection();
    return connection.request(request);
  }

  /** Ends the connection, if one is open. */
  close(): void {
    this.generation++;
    this.stream?.close();
    this.stream = null;
    this.connection = null;
    this.opening = null;
  }

  private settleOpening(opening: Promise<Http1Connection>): void {
    if (this.opening === opening) this.opening = null;
  }

  /** The open connection, or a new one when there is none or it is spent. */
  private usableConnection(): Promise<Http1Connection> {
    if (this.connection?.usable) return Promise.resolve(this.connection);
    if (this.opening) return this.opening;
    if (this.connection) {
      Log.d('MAIL-SOAP', 'the connection is spent - opening a new one');
      this.stream?.close();
    }
    this.connection = null;
    this.stream = null;
    const generation = this.generation;
    const opening = this.openStream().then((stream) => {
      if (generation !== this.generation) {
        // CLOSED WHILE IT OPENED (the watcher stopped mid-connect): the new stream is closed at
        // once, and the call that waited for it fails as a transport closed by us.
        stream.close();
        Log.d('MAIL-SOAP', 'a connection opened after the client was closed - closed at once');
        throw new MailTransportError('closed', 'the client was closed while it opened');
      }
      this.stream = stream;
      this.connection = new Http1Connection(stream, MAIL_HOST);
      return this.connection;
    });
    this.opening = opening;
    void opening.then(
      () => this.settleOpening(opening),
      () => this.settleOpening(opening)
    );
    return opening;
  }
}
