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
  // 150 ms of work per send: long enough that a retirement always finds some in flight.
  setTimeout(() => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ version: VERSION }));
  }, 150);
});

process.once('SIGTERM', () => {
  console.log(`[DRAIN] ${VERSION}: SIGTERM - closing the listener, finishing in-flight requests`);
  server.close(() => {
    console.log(`[DRAIN] ${VERSION}: every in-flight request answered - exiting`);
    process.exit(0);
  });
});

server.listen(3000, () => console.log(`api ${VERSION} listening`));
