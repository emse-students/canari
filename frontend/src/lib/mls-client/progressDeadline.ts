/**
 * A request abandoned because NOTHING arrived for a while - never because it took a while.
 *
 * Typed rather than message-matched: a stall and a refused connection are different events, and the
 * only place able to tell them apart is the one that armed the deadline. The message carries the
 * evidence a reader needs to separate the two causes a stall itself cannot distinguish - a server
 * that never answered (`headReceived: false`) from a transfer that started and stopped
 * (`headReceived: true`, `bytesReceived > 0`).
 */
export class StalledRequestError extends Error {
  constructor(
    readonly stallMs: number,
    readonly headReceived: boolean,
    readonly bytesReceived: number
  ) {
    super(
      headReceived
        ? `silent for ${stallMs} ms after ${bytesReceived} byte(s) of body - the answer started and stopped`
        : `silent for ${stallMs} ms with no response head - the server never started answering`
    );
    this.name = 'StalledRequestError';
  }
}

/** A 2xx carries the parsed body; anything else carries only its status, and its body is dropped. */
export type ProgressDeadlineResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number };

/**
 * Fetches `url` and parses its JSON body under a PROGRESS deadline.
 *
 * A TOTAL deadline over a request measures the wrong thing: it cannot tell a transfer that is
 * arriving slowly from one that has stopped arriving at all, so the number guarding it has to be
 * large enough for the biggest plausible answer on the slowest plausible link - a product nobody can
 * bound, and therefore a number nobody can justify. A progress deadline asks the question a caller
 * actually has: is anything still coming? It is honest at any answer size and any link speed, and it
 * needs no calibration.
 *
 * So the timer is armed once before the request and RE-ARMED on every arrival - the response head,
 * then each body chunk. It fires only on `stallMs` of complete silence. Both halves are real on both
 * platforms: the browser streams `res.body`, and Tauri's `plugin-http` builds its `Response` over a
 * `ReadableStream` that pulls chunks across the IPC boundary, so a chunk arriving there is a chunk
 * arriving here.
 *
 * @param fetchImpl `globalThis.fetch` on web, `plugin-http`'s on Tauri.
 * @param init the request WITHOUT a signal - this function owns the only one, and a second could
 *   silently replace it.
 * @param stallMs the longest silence tolerated. It bounds SILENCE, not transfer, so it only has to
 *   exceed the longest quiet stretch the design permits (a server assembling one bounded page).
 * @throws StalledRequestError when nothing arrived for `stallMs`; the underlying error otherwise.
 */
export async function fetchJsonUnderProgressDeadline<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: Omit<RequestInit, 'signal'>,
  stallMs: number
): Promise<ProgressDeadlineResult<T>> {
  const ctrl = new AbortController();
  let stalled = false;
  let headReceived = false;
  let bytesReceived = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** (Re)arms the silence timer. Every arrival is progress, and progress buys another full window. */
  const heard = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, stallMs);
  };

  /**
   * Rejects the moment the deadline fires, and is raced against every `read()`.
   *
   * Aborting the signal is what stops the REQUEST; it is not what stops a read already awaiting a
   * chunk. A `Response` built over a stream that was never handed the signal - Tauri's is, a
   * hand-rolled one is not - would leave that read pending forever, which is the one outcome a
   * hang-guard may not have. So the wait is bounded here rather than assumed elsewhere. The no-op
   * handler is what keeps a rejection during the head phase, which the race never sees, from
   * surfacing as an unhandled one.
   */
  const abortedWhileReading = new Promise<never>((_, reject) => {
    ctrl.signal.addEventListener('abort', () => reject(new Error('stalled')), { once: true });
  });
  abortedWhileReading.catch(() => {});

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    heard();
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    headReceived = true;
    heard();

    if (!res.ok) {
      // Nothing here reads a non-2xx body, and an unread one holds the connection open until it is
      // collected. Cancelling is not a failure path, so a refusal to cancel is not one either.
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status };
    }
    if (!res.body) {
      // Per the fetch spec only a null-body status (204, 304, ...) answers without one, and this
      // helper is for endpoints that always answer with JSON. Saying so beats a `SyntaxError`
      // thrown three frames away by `JSON.parse('')`.
      throw new Error(`${url} answered ${res.status} with no body, where JSON was expected`);
    }

    reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), abortedWhileReading]);
      if (done) break;
      if (!value) continue;
      bytesReceived += value.byteLength;
      chunks.push(value);
      heard();
    }
    clearTimeout(timer);

    const merged = new Uint8Array(bytesReceived);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      status: res.status,
      body: JSON.parse(new TextDecoder().decode(merged)) as T,
    };
  } catch (e) {
    // The abort this function raised is indistinguishable from any other at the catch site, so the
    // classification is made HERE, where the reason is known, and travels as a type.
    if (stalled) {
      // Releases the body a stalled read is still holding. The frames already read are discarded
      // with it: half a JSON array is not a smaller answer, it is no answer.
      await reader?.cancel().catch(() => {});
      throw new StalledRequestError(stallMs, headReceived, bytesReceived);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
