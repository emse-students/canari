// A stand-in for one NestJS service, for deploy-rolling.test.sh: an HTTP server on the runtime the
// services run on (bun, through `node:http` as express uses it), answering a send after a delay so
// that requests are genuinely IN FLIGHT when the deploy retires a replica, and leaving on SIGTERM the
// way `drain-on-sigterm.ts` makes the real services leave: stop listening, answer what is in flight,
// exit.
import http from 'node:http';

const VERSION = process.env.VERSION ?? 'unset';
// A release whose new replica never comes up: the test's "the old replica keeps serving" case.
if (VERSION.startsWith('broken')) {
  console.log(`api ${VERSION}: refusing to start`);
  process.exit(1);
}
const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.end('ok');
    return;
  }
  // A connection that stays open, as a WebSocket does: a byte every 200 ms until the client leaves.
  // The nginx worker proxying it outlives a reload, and the release must not wait for it to end.
  if (req.url === '/api/hold') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const tick = setInterval(() => res.write('.'), 200);
    req.on('close', () => clearInterval(tick));
    return;
  }
  // 150 ms of work per send: long enough that a retirement always finds some in flight.
  setTimeout(() => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ version: VERSION }));
  }, 150);
});

// THE EVENT LOOP IS BUSY WHEN SIGTERM ARRIVES, ON PURPOSE (2026-11-01). Between the kernel completing a
// handshake and the process calling accept(), a connection waits in the listener's accept queue, and
// closing the listener RESETS every connection still waiting there - after nginx has already sent
// the POST into it, so nginx may not replay it and answers 502 (main CI run 41311303760, 1 POST in
// 346; `recv() failed (104: Connection reset by peer) while reading response header from upstream`).
// That window is as wide as the event loop is busy - a loaded NestJS replica's is not empty - and here
// it is made wide enough that a retirement still IN ROTATION is caught every run, not once in thirty.
// rolling.sh must therefore take the replica out of rotation and prove its accept queue empty BEFORE
// this handler runs. Kept under the test's ROLLING_DRAIN_SECONDS, so a request accepted before the
// signal is still answered before Docker's kill.
const BUSY_ON_SIGTERM_MS = 1500;

process.once('SIGTERM', () => {
  const until = Date.now() + BUSY_ON_SIGTERM_MS;
  while (Date.now() < until) {
    // busy, as a loaded replica is: no accept() runs, and the kernel keeps queueing handshakes
  }
  console.log(`[DRAIN] ${VERSION}: SIGTERM - closing the listener, finishing in-flight requests`);
  server.close(() => {
    console.log(`[DRAIN] ${VERSION}: every in-flight request answered - exiting`);
    process.exit(0);
  });
});

server.listen(3000, () => console.log(`api ${VERSION} listening`));
